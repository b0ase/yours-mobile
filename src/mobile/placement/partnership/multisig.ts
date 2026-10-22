// The M-of-N signing engine shared by Partnership shares (partnerLock.ts) and the partnership's shared account
// (accountRules.ts). A proposal is a fully built transaction (extended format, unlocking scripts empty) plus, for
// every multisig input, the keyset it is locked under. Partners sign SIGHASH_ALL over the final transaction, so
// nothing about it can change after the first signature. finalize() refuses until every multisig input has m
// valid signatures and runs the script interpreter locally before returning a broadcastable hex.
//
// Pure: no network, no keys held. Tests: partnerLock.test.ts, accountRules.test.ts.
import {
  Hash,
  OP,
  PublicKey,
  Script,
  Signature,
  Spend,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  Utils,
} from '@bsv/sdk';

export const SCOPE = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID;

export type MultisigInput = { index: number; m: number; pubKeys: string[] };

export type Signable = {
  /** Extended-format tx (each input's source amount + script), unlocking scripts empty. */
  txEF: string;
  /** Multisig inputs and the keyset each was locked under. */
  locked: MultisigInput[];
  /** Optional single-key P2PKH input already signed by the proposer (Partnership shares' exact fee input). */
  fee?: { index: number; pubKey: string; sig: string };
  /** input index → partner pubkey → checksig signature hex. */
  sigs: Record<string, Record<string, string>>;
};

export const proposalTx = (p: Pick<Signable, 'txEF'>) => Transaction.fromHexEF(p.txEF);

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

export function sigValid(tx: Transaction, i: number, pubKey: string, checksigHex: string): boolean {
  try {
    const bytes = Utils.toArray(checksigHex, 'hex');
    if (bytes[bytes.length - 1] !== SCOPE) return false;
    const ts = TransactionSignature.fromChecksigFormat(bytes);
    return PublicKey.fromString(pubKey).verify(Hash.sha256(preimage(tx, i)), ts);
  } catch {
    return false;
  }
}

/** Which multisig inputs a partner key can sign on this proposal. */
export const inputsFor = (p: Pick<Signable, 'locked'>, pubKey: string) =>
  p.locked.filter((l) => l.pubKeys.includes(pubKey.toLowerCase())).map((l) => l.index);

/**
 * Adds one partner's signatures (input index → checksig hex). Every signature is checked against the transaction
 * and the key; a bad one throws and nothing is added. Returns a new proposal.
 */
export function addSignatures<T extends Signable>(p: T, pubKey: string, sigs: Record<number, string>): T {
  const key = pubKey.toLowerCase();
  const tx = proposalTx(p);
  const next: T = {
    ...p,
    sigs: Object.fromEntries(Object.entries(p.sigs).map(([k, v]) => [k, { ...v }])),
  };
  for (const [idx, sig] of Object.entries(sigs)) {
    const i = Number(idx);
    const l = p.locked.find((x) => x.index === i);
    if (!l) throw new Error(`Input ${i} is not a multisig input`);
    if (!l.pubKeys.includes(key)) throw new Error('That key is not one of these partners');
    if (!sigValid(tx, i, key, sig)) throw new Error('That signature does not match this transaction');
    next.sigs[String(i)] = { ...(next.sigs[String(i)] ?? {}), [key]: sig.toLowerCase() };
  }
  return next;
}

/** Valid signatures per multisig input vs what each needs. */
export function progress(p: Signable): { index: number; have: number; need: number }[] {
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
export const isReady = (p: Signable) => progress(p).every((x) => x.have >= x.need);

/** Partner keys that have signed every input they can sign (valid signatures only). */
export function signedBy(p: Signable): string[] {
  const tx = proposalTx(p);
  const all = [...new Set(p.locked.flatMap((l) => l.pubKeys))];
  return all.filter((k) => {
    const mine = inputsFor(p, k);
    return mine.length > 0 && mine.every((i) => sigValid(tx, i, k, p.sigs[String(i)]?.[k] ?? ''));
  });
}

/** Partner keys that haven't signed every input they can sign yet ("Signature needed"). */
export const waitingOn = (p: Signable) => {
  const all = [...new Set(p.locked.flatMap((l) => l.pubKeys))];
  return all.filter((k) => inputsFor(p, k).some((i) => !p.sigs[String(i)]?.[k]));
};

/**
 * Combines two copies of the same proposal (each partner returns their own signed copy). Only signatures that
 * verify against the shared transaction are kept, so a tampered copy adds nothing. Throws if the transactions differ.
 */
export function mergeSignatures<T extends Signable>(a: T, b: Signable): T {
  if (proposalTx(a).id('hex') !== proposalTx(b).id('hex')) throw new Error('These are two different proposals');
  const tx = proposalTx(a);
  const next: T = { ...a, sigs: Object.fromEntries(Object.entries(a.sigs).map(([k, v]) => [k, { ...v }])) };
  for (const l of a.locked) {
    for (const k of l.pubKeys) {
      const s = b.sigs[String(l.index)]?.[k];
      if (s && !next.sigs[String(l.index)]?.[k] && sigValid(tx, l.index, k, s))
        next.sigs[String(l.index)] = { ...(next.sigs[String(l.index)] ?? {}), [k]: s.toLowerCase() };
    }
  }
  return next;
}

/**
 * The broadcastable transaction. Refuses with too few signatures. Signatures go in key order (CHECKMULTISIG needs
 * the script's order); each input is run through the interpreter before the hex is returned.
 */
export function finalize(p: Signable): { rawTx: string; txid: string } {
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
  if (p.fee) {
    if (!sigValid(tx, p.fee.index, p.fee.pubKey, p.fee.sig)) throw new Error('The fee signature does not match');
    tx.inputs[p.fee.index].unlockingScript = new UnlockingScript(
      new Script().writeBin(Utils.toArray(p.fee.sig, 'hex')).writeBin(Utils.toArray(p.fee.pubKey, 'hex')).chunks,
    );
  }
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
