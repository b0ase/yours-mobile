// bTrust signing: real check-in and heir-claim transactions, signed with seed-derived wallet keys.
//
// Every signature is made by the wallet (BRC-100 createSignature with hashToDirectlySign), so no private key
// leaves it. Every finished transaction can be checked locally with verifySpend (the @bsv/sdk script
// interpreter), so nothing depends on our server: the heirs and the owner can verify before broadcasting.
//
// Check-in: spend the owner branch and re-lock the same amount (less the fee) under a later plan, plus a
//           1-sat beacon to the owner's lock address so a seed-only scan finds the new lock (derive.ts).
// Lead heir: after leadHeight, the lead heir spends alone (1Sat Lock unlock + OP_0 OP_0).
// Two heirs: after heirsHeight, one heir builds the claim and signs; the other heir adds their signature
//            (heirSignature / finishHeirsClaim). The order of signatures follows the plan's heir order.

import { Lock } from '@1sat/templates';
import {
  BigNumber,
  ECDSA,
  Hash,
  LockingScript,
  OP,
  P2PKH,
  PublicKey,
  Script,
  Signature,
  Spend,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  Utils,
  type WalletInterface,
} from '@bsv/sdk';
import { BTRUST_PROTOCOL, GATE_KEY, inheritanceLock, validatePlan, type InheritancePlan } from './inheritance';
import { beaconScript, heirKeyID, ownerKeyID } from './derive';

const SCOPE = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID;
/** Sats per kB. Check-ins are about 4 kB (two lock scripts), so this is a few hundred sats. */
export const FEE_RATE = 100;
export const BEACON_SATS = 1;

/** Signs a 32-byte digest directly; returns a DER signature (no sighash byte). */
export type HashSigner = { pubKey: string; sign: (digest: number[]) => Promise<number[]> };

type SigningWallet = Pick<WalletInterface, 'createSignature' | 'getPublicKey'>;

/** A HashSigner backed by the wallet's seed-derived bTrust key. The key never leaves the wallet. */
export async function walletSigner(wallet: SigningWallet, keyID: string): Promise<HashSigner> {
  const { publicKey } = await wallet.getPublicKey({ protocolID: BTRUST_PROTOCOL, keyID, counterparty: 'self' });
  return {
    pubKey: publicKey,
    sign: async (digest) =>
      (
        await wallet.createSignature({
          protocolID: BTRUST_PROTOCOL,
          keyID,
          counterparty: 'self',
          hashToDirectlySign: digest,
        })
      ).signature,
  };
}

export const ownerSigner = (wallet: SigningWallet, index = 0) => walletSigner(wallet, ownerKeyID(index));
export const heirSigner = (wallet: SigningWallet) => walletSigner(wallet, heirKeyID());

function sourceOf(tx: Transaction, i: number) {
  const input = tx.inputs[i];
  if (!input) throw new Error(`no input ${i}`);
  const out = input.sourceTransaction?.outputs[input.sourceOutputIndex];
  const sourceTXID = input.sourceTXID ?? input.sourceTransaction?.id('hex');
  if (!out || out.satoshis === undefined || !sourceTXID) throw new Error('input needs its source transaction');
  return { input, out, sourceTXID, sats: out.satoshis };
}

/** BIP143-style preimage for input i (SIGHASH_ALL | FORKID) and its double-SHA256 digest. */
export function inputSighash(tx: Transaction, i: number) {
  const { input, out, sourceTXID, sats } = sourceOf(tx, i);
  const preimage = TransactionSignature.format({
    sourceTXID,
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: sats,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, j) => j !== i),
    outputs: tx.outputs,
    inputIndex: i,
    subscript: out.lockingScript,
    inputSequence: input.sequence ?? 0xffffffff,
    lockTime: tx.lockTime,
    scope: SCOPE,
  });
  return { preimage, digest: Hash.hash256(preimage) };
}

/** Checksig-format signature (DER + sighash byte) for input i. */
export async function signInput(tx: Transaction, i: number, signer: HashSigner): Promise<number[]> {
  const der = await signer.sign(inputSighash(tx, i).digest);
  return [...der, SCOPE];
}

/** True when `sig` (checksig format) is `pubKey`'s valid signature over input i of `tx` as it is now. */
export function verifyInputSignature(tx: Transaction, i: number, pubKey: string, sig: number[]): boolean {
  try {
    if (sig[sig.length - 1] !== SCOPE) return false;
    const s = Signature.fromDER(sig.slice(0, -1));
    return ECDSA.verify(new BigNumber(inputSighash(tx, i).digest), s, PublicKey.fromString(pubKey));
  } catch {
    return false;
  }
}

/** Run the script interpreter on input i: true only if the chain would accept it. */
export function verifySpend(tx: Transaction, i = 0): boolean {
  try {
    const { input, out, sourceTXID, sats } = sourceOf(tx, i);
    if (!input.unlockingScript) return false;
    return new Spend({
      sourceTXID,
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: sats,
      lockingScript: out.lockingScript,
      transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, j) => j !== i),
      outputs: tx.outputs,
      inputIndex: i,
      unlockingScript: input.unlockingScript,
      inputSequence: input.sequence ?? 0xffffffff,
      lockTime: tx.lockTime,
    }).validate();
  } catch {
    return false;
  }
}

const feeFor = (bytes: number, rate = FEE_RATE) => Math.max(1, Math.ceil((bytes * rate) / 1000));

/** The lock output being spent; refuses an output that is not exactly `plan`'s lock. */
function lockInput(lockTx: Transaction, vout: number, plan: InheritancePlan) {
  const out = lockTx.outputs[vout];
  if (!out || !out.satoshis) throw new Error('that output does not exist');
  if (out.lockingScript.toHex() !== inheritanceLock(plan).toHex()) throw new Error('that output is not this plan');
  return out.satoshis;
}

// ── owner check-in ───────────────────────────────────────────────────────────

/**
 * Sign a check-in: spend `lockTx:vout` (locked to `plan`) through the owner branch and re-lock it under `next`
 * (same keys, later heights), with a 1-sat beacon to the owner's address. The fee comes out of the lock.
 */
export async function signCheckIn(opts: {
  lockTx: Transaction;
  vout: number;
  plan: InheritancePlan;
  next: InheritancePlan;
  owner: HashSigner;
  feeRate?: number;
}): Promise<Transaction> {
  const { lockTx, vout, owner } = opts;
  const plan = validatePlan(opts.plan);
  const next = validatePlan(opts.next);
  if (next.ownerPubKey !== plan.ownerPubKey) throw new Error('check-in keeps the same owner key');
  if (JSON.stringify(next.heirs.map((h) => h.pubKey)) !== JSON.stringify(plan.heirs.map((h) => h.pubKey)))
    throw new Error('check-in keeps the same heirs');
  if (owner.pubKey !== plan.ownerPubKey) throw new Error('this wallet does not hold the owner key for that lock');
  const sats = lockInput(lockTx, vout, plan);

  const build = (fee: number) => {
    const keep = sats - fee - BEACON_SATS;
    if (keep < 1) throw new Error('the lock is too small to pay the check-in fee');
    const tx = new Transaction();
    tx.addInput({ sourceTransaction: lockTx, sourceOutputIndex: vout, sequence: 0xffffffff });
    tx.addOutput({ lockingScript: inheritanceLock(next), satoshis: keep });
    tx.addOutput({ lockingScript: beaconScript(plan.ownerPubKey), satoshis: BEACON_SATS });
    return tx;
  };
  const sign = async (tx: Transaction) => {
    const sig = await signInput(tx, 0, owner);
    tx.inputs[0].unlockingScript = new UnlockingScript(new Script().writeBin(sig).writeOpCode(OP.OP_1).chunks);
    return tx;
  };
  // Size with a 73-byte signature placeholder, then sign once for real.
  const draft = build(1);
  draft.inputs[0].unlockingScript = new UnlockingScript(
    new Script().writeBin(new Array(73).fill(0)).writeOpCode(OP.OP_1).chunks,
  );
  const tx = await sign(build(feeFor(draft.toBinary().length, opts.feeRate)));
  if (!verifySpend(tx)) throw new Error('the check-in did not verify');
  return tx;
}

// ── owner withdraw ──────────────────────────────────────────────────────────

/**
 * Cancel the lock: spend the owner branch and pay everything (less the fee) to `payTo`, normally the wallet's
 * own receive address. Verified by the interpreter before it is returned.
 */
export async function signWithdraw(opts: {
  lockTx: Transaction;
  vout: number;
  plan: InheritancePlan;
  owner: HashSigner;
  payTo: string | LockingScript;
  feeRate?: number;
}): Promise<Transaction> {
  const plan = validatePlan(opts.plan);
  if (opts.owner.pubKey !== plan.ownerPubKey) throw new Error('this wallet does not hold the owner key for that lock');
  const sats = lockInput(opts.lockTx, opts.vout, plan);
  const script = typeof opts.payTo === 'string' ? new P2PKH().lock(opts.payTo) : opts.payTo;
  const fee = feeFor(10 + 41 + 75 + 9 + script.toBinary().length + 4, opts.feeRate);
  if (sats - fee < 1) throw new Error('the lock is too small to pay the fee');
  const tx = new Transaction();
  tx.addInput({ sourceTransaction: opts.lockTx, sourceOutputIndex: opts.vout, sequence: 0xffffffff });
  tx.addOutput({ lockingScript: script, satoshis: sats - fee });
  const sig = await signInput(tx, 0, opts.owner);
  tx.inputs[0].unlockingScript = new UnlockingScript(new Script().writeBin(sig).writeOpCode(OP.OP_1).chunks);
  if (!verifySpend(tx)) throw new Error('the withdrawal did not verify');
  return tx;
}

// ── heir claims ──────────────────────────────────────────────────────────────

/** Unsigned claim of `lockTx:vout` to `payTo` (a P2PKH address or locking script) at nLockTime `height`. */
function claimTx(
  lockTx: Transaction,
  vout: number,
  plan: InheritancePlan,
  payTo: string | LockingScript,
  height: number,
  unlockBytes: number,
  feeRate?: number,
) {
  const sats = lockInput(lockTx, vout, plan);
  const script = typeof payTo === 'string' ? new P2PKH().lock(payTo) : payTo;
  const fee = feeFor(10 + 41 + unlockBytes + 9 + script.toBinary().length + 4, feeRate);
  if (sats - fee < 1) throw new Error('the lock is too small to pay the claim fee');
  const tx = new Transaction();
  tx.lockTime = height;
  // nSequence below final so nLockTime is enforced (the 1Sat Lock refuses a final sequence).
  tx.addInput({ sourceTransaction: lockTx, sourceOutputIndex: vout, sequence: 0xfffffffe });
  tx.addOutput({ lockingScript: script, satoshis: sats - fee });
  return tx;
}

/** Lead heir alone, at or after leadHeight. `height` is the current chain height. */
export async function signLeadClaim(opts: {
  lockTx: Transaction;
  vout: number;
  plan: InheritancePlan;
  lead: HashSigner;
  payTo: string | LockingScript;
  height: number;
  feeRate?: number;
}): Promise<Transaction> {
  const plan = validatePlan(opts.plan);
  if (opts.lead.pubKey !== plan.heirs[0].pubKey) throw new Error('only the lead heir can claim alone');
  if (opts.height < plan.leadHeight) throw new Error('the lead heir cannot claim yet');
  const tx = claimTx(opts.lockTx, opts.vout, plan, opts.payTo, opts.height, 1100, opts.feeRate);
  const { preimage } = inputSighash(tx, 0);
  const sig = await signInput(tx, 0, opts.lead);
  tx.inputs[0].unlockingScript = new UnlockingScript(
    new Script()
      .writeBin(sig)
      .writeBin(Utils.toArray(opts.lead.pubKey, 'hex'))
      .writeBin(preimage)
      .writeOpCode(OP.OP_0)
      .writeOpCode(OP.OP_0).chunks,
  );
  if (!verifySpend(tx)) throw new Error('the claim did not verify');
  return tx;
}

/** Any two heirs, step 1: build the unsigned claim (share its hex with the co-signing heir). */
export function buildHeirsClaim(opts: {
  lockTx: Transaction;
  vout: number;
  plan: InheritancePlan;
  payTo: string | LockingScript;
  height: number;
  feeRate?: number;
}): Transaction {
  const plan = validatePlan(opts.plan);
  if (opts.height < plan.heirsHeight) throw new Error('the heirs cannot claim yet');
  const tx = claimTx(opts.lockTx, opts.vout, plan, opts.payTo, opts.height, 1250, opts.feeRate);
  // Empty unlock so the draft serialises to hex for the co-signer; signatures do not cover it.
  tx.inputs[0].unlockingScript = new UnlockingScript([]);
  return tx;
}

/** Any two heirs, step 2 (each heir): this heir's signature over the claim, with their seat in the plan. */
export async function heirSignature(tx: Transaction, plan: InheritancePlan, heir: HashSigner) {
  const seat = plan.heirs.findIndex((h) => h.pubKey === heir.pubKey);
  if (seat < 0) throw new Error('your heir key is not in this plan');
  return { seat, sig: await signInput(tx, 0, heir) };
}

/** Any two heirs, step 3: check both signatures, assemble the unlock and verify the whole spend. */
export async function finishHeirsClaim(
  tx: Transaction,
  plan: InheritancePlan,
  sigs: { seat: number; sig: number[] }[],
): Promise<Transaction> {
  const seats = [...new Map(sigs.map((s) => [s.seat, s])).values()].sort((a, b) => a.seat - b.seat);
  if (seats.length < 2) throw new Error('two different heirs must sign');
  const two = seats.slice(0, 2);
  for (const s of two)
    if (!plan.heirs[s.seat] || !verifyInputSignature(tx, 0, plan.heirs[s.seat].pubKey, s.sig))
      throw new Error(`heir ${s.seat + 1}'s signature does not match this claim`);
  const gate = await Lock.unlock(GATE_KEY).sign(tx, 0);
  gate.writeOpCode(OP.OP_0);
  for (const s of two) gate.writeBin(s.sig);
  gate.writeOpCode(OP.OP_1).writeOpCode(OP.OP_0);
  tx.inputs[0].unlockingScript = new UnlockingScript(gate.chunks);
  if (!verifySpend(tx)) throw new Error('the claim did not verify');
  return tx;
}
