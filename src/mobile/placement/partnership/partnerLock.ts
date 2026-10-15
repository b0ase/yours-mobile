// Partnership shares PARTNER LOCK (owner, 15 Oct 2026): a partner's Partnership shares (the room's BSV-21 tokens
// allocated to them) sit in an on-chain M-of-N multisig over every partner's key, so they only move with the
// partners' agreed signatures. That is what keeps them a private partnership and not a public offer.
//
// Output script (1 sat, one per holding):
//   <BSV-21 transfer inscription {p:"bsv-20",op:"transfer",id,amt}>
//   <holderKey> OP_DROP                         who the holding belongs to (data only, not a spend condition)
//   OP_m <k1> … <kn> OP_n OP_CHECKMULTISIG      the partners' keys, sorted, m from the agreement's transfer rule
//
// unanimous → m = n; majority → the agreed M. Keys: each partner's wallet derives a key from its own seed
// (BRC-42 'self', protocol PARTNER_LOCK_PROTOCOL, keyID = partnership id). Nobody else holds it, we never see it.
//
// Recovery, no server: seed → this partnership's key; the agreement record (partners' public keys + rule) →
// the exact script; any BSV-21 indexer lists the token's unspent outputs → filter by parsePartnerLock(). The
// partners then sign the same way with the record alone (exportProposal / importProposal travel by any channel).
//
// Locked holdings are not P2PKH, so they never enter the wallet's BSV-21 basket: Send, Sell and the Exchange
// cannot select them; isPartnerLocked() is the explicit guard.
//
// Spending: a proposal is a fully built transaction (locked inputs + one exact-fee input from the proposer's
// seed-derived key, no change), so every signature is SIGHASH_ALL over the final transaction and nothing about
// it can change after the first partner signs. finalize() refuses to produce a broadcastable transaction until
// every locked input has m valid signatures, and runs the script interpreter locally before returning.
//
// Pure: no network, no keys held (signers are passed in). Tests: partnerLock.test.ts.
import { BSV21 } from '@1sat/templates';
import {
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
} from '@bsv/sdk';

/** BRC-100 protocol for partner lock keys: getPublicKey/createSignature, keyID = partnership id, counterparty 'self'. */
export const PARTNER_LOCK_PROTOCOL: [2, string] = [2, 'bwx partnership'];
export const MAX_PARTNER_KEYS = 16;
export const SCOPE = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID;
/** Fee rate for proposals (sats per kB). The fee input is exact; no change output. */
export const FEE_RATE_SATS_PER_KB = 100;
export const MIN_FEE_SATS = 50;

export type TransferRule = { kind: 'unanimous' } | { kind: 'majority'; m: number };
/** Signatures a move needs. Same rule as bit-sign src/lib/partnership.ts signaturesForTransfer. */
export const signaturesNeeded = (rule: TransferRule, partners: number) =>
  rule.kind === 'unanimous' ? partners : Math.min(Math.max(1, rule.m), partners);

/** The partner key the wallet derives for one partnership (keyID). */
export const partnerKeyId = (partnershipId: string) => partnershipId.slice(0, 200);
/** The proposer's one-off fee key for one proposal (recoverable from the seed with the proposal id). */
export const feeKeyId = (partnershipId: string, proposalId: string) =>
  `${partnershipId}:fee:${proposalId}`.slice(0, 200);

const isPub = (k: string) => /^0[23][0-9a-f]{64}$/.test(k);
const smallInt = (n: number) => OP.OP_1 + n - 1;
const readSmallInt = (op: number) => (op >= OP.OP_1 && op <= OP.OP_16 ? op - OP.OP_1 + 1 : -1);

export type Keyset = { m: number; pubKeys: string[] };

/** Canonical keyset: keys sorted, checked. Every partner builds the identical script from the record. */
export function keysetFor(rule: TransferRule, pubKeys: string[]): Keyset {
  const keys = [...pubKeys].map((k) => k.toLowerCase()).sort();
  if (keys.length < 2) throw new Error('A partner lock needs at least two partners');
  if (keys.length > MAX_PARTNER_KEYS) throw new Error(`At most ${MAX_PARTNER_KEYS} partners can share a lock`);
  if (!keys.every(isPub)) throw new Error('Every partner key must be a compressed public key');
  if (new Set(keys).size !== keys.length) throw new Error('Partner keys must be distinct');
  const m = signaturesNeeded(rule, keys.length);
  if (rule.kind === 'majority' && m < Math.floor(keys.length / 2) + 1)
    throw new Error(`Majority means at least ${Math.floor(keys.length / 2) + 1} of ${keys.length}`);
  return { m, pubKeys: keys };
}

/** The multisig part on its own (holder tag + m-of-n). */
export function lockBody(keyset: Keyset, holder: string): Script {
  const h = holder.toLowerCase();
  if (!keyset.pubKeys.includes(h)) throw new Error('The holder must be one of the partners');
  const s = new Script().writeBin(Utils.toArray(h, 'hex')).writeOpCode(OP.OP_DROP).writeOpCode(smallInt(keyset.m));
  for (const k of keyset.pubKeys) s.writeBin(Utils.toArray(k, 'hex'));
  return s.writeOpCode(smallInt(keyset.pubKeys.length)).writeOpCode(OP.OP_CHECKMULTISIG);
}

export type Holding = { tokenId: string; amt: bigint; holder: string };

/** The locked BSV-21 output script for one partner's holding. */
export function partnerLockScript(h: Holding, keyset: Keyset): LockingScript {
  if (h.amt <= 0n) throw new Error('A holding must be more than 0 shares');
  const body = new LockingScript(lockBody(keyset, h.holder).chunks);
  return BSV21.transfer(h.tokenId, h.amt).lock(body);
}

export type ParsedPartnerLock = Holding & Keyset;

/** Reads a partner lock back (null when the script isn't one). Used for recovery scans and the Exchange guard. */
export function parsePartnerLock(script: Script): ParsedPartnerLock | null {
  const c = script.chunks;
  for (let j = c.length - 1; j >= 0; j--) {
    if (c[j].op !== OP.OP_CHECKMULTISIG) continue;
    const n = readSmallInt(c[j - 1]?.op ?? -1);
    if (n < 2) continue;
    const keys: string[] = [];
    for (let k = j - 1 - n; k < j - 1; k++) {
      const d = c[k]?.data;
      if (!d || d.length !== 33) break;
      keys.push(Utils.toHex(d));
    }
    if (keys.length !== n) continue;
    const m = readSmallInt(c[j - 2 - n]?.op ?? -1);
    const drop = c[j - 3 - n];
    const tag = c[j - 4 - n]?.data;
    if (m < 1 || m > n || drop?.op !== OP.OP_DROP || !tag || tag.length !== 33) continue;
    const holder = Utils.toHex(tag);
    if (!keys.includes(holder)) return null;
    const token = BSV21.decode(script);
    const tokenId = token?.getTokenId();
    if (!token || token.getOperation() !== 'transfer' || !tokenId) return null;
    return { tokenId, amt: token.getAmount(), holder, m, pubKeys: keys };
  }
  return null;
}

/** True when an output is a locked partnership holding. The Exchange and Sell never list these. */
export const isPartnerLocked = (script: Script) => parsePartnerLock(script) !== null;

/** Wallet/Exchange label (owner term). */
export const partnershipLabel = (shares: bigint | number) =>
  `Partnership shares · ${BigInt(shares).toLocaleString('en-GB')} · locked`;

// ── proposals ────────────────────────────────────────────────────────────────

export type LockedUtxo = { sourceTx: Transaction; vout: number };
export type FeeUtxo = { sourceTx: Transaction; vout: number; pubKey: string };
export type ProposalKind = 'transfer' | 'admit' | 'remove';

export type PartnerProposal = {
  v: 1;
  partnershipId: string;
  /** Agreement version whose keyset signs (the CURRENT one; an admission's new keyset is in the outputs). */
  agreementVersion: number;
  proposalId: string;
  kind: ProposalKind;
  /** Plain words: "Send 1,000 shares from $ann to $ben". */
  summary: string;
  /** Extended-format tx (carries each input's source amount + script), unlocking scripts empty. */
  txEF: string;
  /** Locked inputs and the keyset each was locked under. */
  locked: { index: number; m: number; pubKeys: string[] }[];
  fee: { index: number; pubKey: string; sig: string };
  /** input index → partner pubkey → checksig signature hex. */
  sigs: Record<string, Record<string, string>>;
};

export type MovePlan = {
  partnershipId: string;
  agreementVersion: number;
  proposalId: string;
  kind: ProposalKind;
  summary: string;
  inputs: LockedUtxo[];
  /** New holdings; every one is locked under `keyset` (the new keyset for an admission). */
  outputs: Holding[];
  keyset: Keyset;
};

const outOf = (u: LockedUtxo) => {
  const o = u.sourceTx.outputs[u.vout];
  if (!o) throw new Error('Locked input is missing its source output');
  return o;
};

/** Estimated size of a move transaction (bytes), for the exact fee input. */
export function moveTxBytes(inputs: { m: number }[], outputScripts: Script[]): number {
  const ins = inputs.reduce((t, i) => t + 41 + 3 + i.m * 73, 0) + 148;
  const outs = outputScripts.reduce((t, s) => t + 9 + 3 + s.toBinary().length, 0);
  return 10 + ins + outs;
}

/** Sats the proposer's fee output must hold for a plan: the miner fee plus any extra 1-sat token outputs. */
export function feeFor(plan: Omit<MovePlan, 'proposalId'> & { proposalId?: string }): number {
  const scripts = plan.outputs.map((h) => partnerLockScript(h, plan.keyset));
  const ins = plan.inputs.map((u) => {
    const p = parsePartnerLock(outOf(u).lockingScript);
    if (!p) throw new Error('Every input must be a partner-locked holding');
    return { m: p.m };
  });
  const miner = Math.max(MIN_FEE_SATS, Math.ceil((moveTxBytes(ins, scripts) * FEE_RATE_SATS_PER_KB) / 1000));
  const inSats = plan.inputs.reduce((t, u) => t + (outOf(u).satoshis ?? 0), 0);
  return miner + Math.max(0, scripts.length - inSats);
}

/** Checks a plan: same token throughout, shares conserved exactly, no empty outputs. */
export function checkPlan(plan: MovePlan): void {
  if (!plan.inputs.length) throw new Error('Nothing to move');
  if (!plan.outputs.length) throw new Error('Say where the shares go');
  const parsed = plan.inputs.map((u) => parsePartnerLock(outOf(u).lockingScript));
  if (parsed.some((p) => !p)) throw new Error('Every input must be a partner-locked holding');
  const tokenId = parsed[0]!.tokenId;
  if (parsed.some((p) => p!.tokenId !== tokenId) || plan.outputs.some((o) => o.tokenId !== tokenId))
    throw new Error('A move carries one token only');
  const inAmt = parsed.reduce((t, p) => t + p!.amt, 0n);
  const outAmt = plan.outputs.reduce((t, o) => t + o.amt, 0n);
  if (inAmt !== outAmt) throw new Error(`Shares must balance: ${inAmt} in, ${outAmt} out`);
}

/**
 * Builds the proposal and the proposer's fee signature. `signFee` signs the fee input (wallet: createSignature with
 * hashToDirectlySign, feeKeyId). The proposer's own partner signature is added afterwards like everyone else's.
 */
export async function propose(
  plan: MovePlan,
  fee: FeeUtxo,
  signFee: (sighash: number[]) => Promise<number[]>,
): Promise<PartnerProposal> {
  checkPlan(plan);
  const feeOut = fee.sourceTx.outputs[fee.vout];
  if (!feeOut) throw new Error('Fee input is missing its source output');
  const feeScript = new P2PKH().lock(PublicKey.fromString(fee.pubKey).toAddress());
  if (feeOut.lockingScript.toHex() !== feeScript.toHex()) throw new Error('Fee input does not belong to the fee key');
  if ((feeOut.satoshis ?? 0) < feeFor(plan)) throw new Error('Fee input is too small for this move');
  const tx = new Transaction();
  for (const u of plan.inputs)
    tx.addInput({ sourceTransaction: u.sourceTx, sourceOutputIndex: u.vout, sequence: 0xffffffff });
  tx.addInput({ sourceTransaction: fee.sourceTx, sourceOutputIndex: fee.vout, sequence: 0xffffffff });
  for (const h of plan.outputs) tx.addOutput({ lockingScript: partnerLockScript(h, plan.keyset), satoshis: 1 });
  for (const i of tx.inputs) i.unlockingScript = new UnlockingScript(); // empty until signed (EF needs a value)
  const feeIndex = plan.inputs.length;
  const feeSig = await signFee(sighash(tx, feeIndex));
  return {
    v: 1,
    partnershipId: plan.partnershipId,
    agreementVersion: plan.agreementVersion,
    proposalId: plan.proposalId,
    kind: plan.kind,
    summary: plan.summary,
    txEF: tx.toHexEF(),
    locked: plan.inputs.map((u, index) => {
      const p = parsePartnerLock(outOf(u).lockingScript)!;
      return { index, m: p.m, pubKeys: p.pubKeys };
    }),
    fee: { index: feeIndex, pubKey: fee.pubKey.toLowerCase(), sig: Utils.toHex(feeSig) },
    sigs: {},
  };
}

export const proposalTx = (p: PartnerProposal) => Transaction.fromHexEF(p.txEF);

function preimage(tx: Transaction, i: number): number[] {
  const input = tx.inputs[i];
  const out = input.sourceTransaction?.outputs[input.sourceOutputIndex];
  const sourceTXID = input.sourceTXID ?? input.sourceTransaction?.id('hex');
  if (!out || !sourceTXID) throw new Error('Input needs its source');
  return TransactionSignature.format({
    sourceTXID,
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: out.satoshis!,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, j) => j !== i),
    outputs: tx.outputs,
    inputIndex: i,
    subscript: out.lockingScript,
    inputSequence: input.sequence ?? 0xffffffff,
    lockTime: tx.lockTime,
    scope: SCOPE,
  });
}

/** The digest a partner signs for input i (sha256d of the BIP143 preimage) — pass as hashToDirectlySign. */
export const sighash = (tx: Transaction, i: number) => Hash.sha256(Hash.sha256(preimage(tx, i)));

/** DER signature over a digest → checksig format (DER + sighash byte). */
export const toChecksig = (der: number[]) => {
  const s = Signature.fromDER(der);
  return new TransactionSignature(s.r, s.s, SCOPE).toChecksigFormat();
};

function sigValid(tx: Transaction, i: number, pubKey: string, checksigHex: string): boolean {
  try {
    const bytes = Utils.toArray(checksigHex, 'hex');
    if (bytes[bytes.length - 1] !== SCOPE) return false;
    const ts = TransactionSignature.fromChecksigFormat(bytes);
    return PublicKey.fromString(pubKey).verify(Hash.sha256(preimage(tx, i)), ts);
  } catch {
    return false;
  }
}

/** Which locked inputs a partner key can sign on this proposal. */
export const inputsFor = (p: PartnerProposal, pubKey: string) =>
  p.locked.filter((l) => l.pubKeys.includes(pubKey.toLowerCase())).map((l) => l.index);

/**
 * Adds one partner's signatures (input index → checksig hex). Every signature is checked against the transaction
 * and the key; a bad one throws and nothing is added. Returns a new proposal.
 */
export function addSignatures(p: PartnerProposal, pubKey: string, sigs: Record<number, string>): PartnerProposal {
  const key = pubKey.toLowerCase();
  const tx = proposalTx(p);
  const next: PartnerProposal = {
    ...p,
    sigs: Object.fromEntries(Object.entries(p.sigs).map(([k, v]) => [k, { ...v }])),
  };
  for (const [idx, sig] of Object.entries(sigs)) {
    const i = Number(idx);
    const l = p.locked.find((x) => x.index === i);
    if (!l) throw new Error(`Input ${i} is not a locked holding`);
    if (!l.pubKeys.includes(key)) throw new Error('That key is not one of these partners');
    if (!sigValid(tx, i, key, sig)) throw new Error('That signature does not match this transaction');
    next.sigs[String(i)] = { ...(next.sigs[String(i)] ?? {}), [key]: sig.toLowerCase() };
  }
  return next;
}

/** Valid signatures per locked input vs what each needs. */
export function progress(p: PartnerProposal): { index: number; have: number; need: number }[] {
  const tx = proposalTx(p);
  return p.locked.map((l) => ({
    index: l.index,
    need: l.m,
    have: l.pubKeys.filter((k) => {
      const s = p.sigs[String(l.index)]?.[k];
      return !!s && sigValid(tx, l.index, k, s);
    }).length,
  }));
}
export const isReady = (p: PartnerProposal) => progress(p).every((x) => x.have >= x.need);
/** Partner keys that haven't signed every input they can sign yet ("Signature needed"). */
export const waitingOn = (p: PartnerProposal) => {
  const all = [...new Set(p.locked.flatMap((l) => l.pubKeys))];
  return all.filter((k) => inputsFor(p, k).some((i) => !p.sigs[String(i)]?.[k]));
};

/**
 * The broadcastable transaction. Refuses with too few signatures. Signatures go in key order (CHECKMULTISIG needs
 * the script's order); each input is run through the interpreter before the hex is returned.
 */
export function finalize(p: PartnerProposal): { rawTx: string; txid: string } {
  const prog = progress(p);
  const short = prog.filter((x) => x.have < x.need);
  if (short.length)
    throw new Error(
      `Not enough partner signatures yet: ${short.map((x) => `${x.have} of ${x.need}`).join(', ')}. Nothing was broadcast.`,
    );
  const tx = proposalTx(p);
  for (const l of p.locked) {
    const s = new Script().writeOpCode(OP.OP_0);
    let n = 0;
    for (const k of l.pubKeys) {
      const sig = p.sigs[String(l.index)]?.[k];
      if (n < l.m && sig && sigValid(tx, l.index, k, sig)) {
        s.writeBin(Utils.toArray(sig, 'hex'));
        n++;
      }
    }
    tx.inputs[l.index].unlockingScript = new UnlockingScript(s.chunks);
  }
  if (!sigValid(tx, p.fee.index, p.fee.pubKey, p.fee.sig)) throw new Error('The fee signature does not match');
  tx.inputs[p.fee.index].unlockingScript = new UnlockingScript(
    new Script().writeBin(Utils.toArray(p.fee.sig, 'hex')).writeBin(Utils.toArray(p.fee.pubKey, 'hex')).chunks,
  );
  for (let i = 0; i < tx.inputs.length; i++) {
    const input = tx.inputs[i];
    const out = input.sourceTransaction!.outputs[input.sourceOutputIndex];
    const ok = new Spend({
      sourceTXID: input.sourceTXID ?? input.sourceTransaction!.id('hex'),
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: out.satoshis!,
      lockingScript: out.lockingScript,
      transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, j) => j !== i),
      outputs: tx.outputs,
      inputIndex: i,
      unlockingScript: input.unlockingScript!,
      inputSequence: input.sequence ?? 0xffffffff,
      lockTime: tx.lockTime,
    }).validate();
    if (!ok) throw new Error(`Input ${i} failed the local script check. Nothing was broadcast.`);
  }
  return { rawTx: tx.toHex(), txid: tx.id('hex') };
}

/** Proposals travel as JSON (bit-sign pending approvals, or any channel if our server is down). */
export const exportProposal = (p: PartnerProposal) => JSON.stringify(p);
export function importProposal(json: string): PartnerProposal {
  const p = JSON.parse(json) as PartnerProposal;
  if (p?.v !== 1 || typeof p.txEF !== 'string' || !Array.isArray(p.locked) || !p.fee)
    throw new Error('Not a partner proposal');
  const tx = proposalTx(p);
  for (const l of p.locked) {
    const src = tx.inputs[l.index]?.sourceTransaction?.outputs[tx.inputs[l.index].sourceOutputIndex];
    const parsed = src && parsePartnerLock(src.lockingScript);
    if (!parsed || parsed.m !== l.m || parsed.pubKeys.join() !== [...l.pubKeys].join())
      throw new Error('Proposal inputs do not match their locks');
  }
  return p;
}

// ── recovery ─────────────────────────────────────────────────────────────────

/** From any indexer's list of the token's unspent outputs: the ones locked to this partner as holder. */
export function findMyHoldings<T extends { lockingScript: Script }>(
  outputs: T[],
  myKey: string,
): (T & { lock: ParsedPartnerLock })[] {
  const k = myKey.toLowerCase();
  return outputs.flatMap((o) => {
    const lock = parsePartnerLock(o.lockingScript);
    return lock && lock.holder === k ? [{ ...o, lock }] : [];
  });
}
