/**
 * A BRC-177 reclaim goes out only when it is plainly the wallet's own revocation (review rounds 3 and 4, F2).
 *
 * The toolbox's NoSendExpiry task activates a transaction's reclaim (compareAndSetNoSendExpiryState → 'reclaiming',
 * insertReclaim) and posts it; its validateReclaim checks only the reclaim's shape. A page that pointed the reclaim at
 * a withheld payment itself made the task post that payment. Round 3 cancelled every reclaim this device hadn't marked
 * as armed, which also cancelled real ones (two-step actions through the permissions manager, ones made before the
 * release, restores) and left their coins locked. Now nothing is cancelled and nothing is written: before activation
 * (guardReclaimActivation) and before any post of a reclaim (services/beefAncestors.ts guardPostBeef `reclaim`), the
 * reclaim must be, structurally, the wallet's own:
 *  - another transaction than the payment, whose bytes hash to the reclaim txid;
 *  - exactly one input, the anchor: an output in this device's store that the payment itself spends;
 *  - exactly one output, the amount recorded, a P2PKH to the key its derivation prefix/suffix gives with this wallet's
 *    own key deriver (the same lock the toolbox's armReclaim requires);
 *  - its signature verifies against the anchor's locking script (the script interpreter).
 * A reclaim that fails is not activated or posted; the row is left as it is, and the failure logged once.
 */
import { LockingScript, Spend, Transaction } from '@bsv/sdk';
import { ScriptTemplateBRC29 } from '@bsv/wallet-toolbox-client';

type Bytes = ArrayLike<number>;
export type ExpiryRow = {
  transactionId?: number;
  txid?: string | null;
  rawTx?: Bytes | null;
  noSendExpiryState?: string | null;
  noSendExpiryAnchorTxid?: string | null;
  noSendExpiryAnchorVout?: number | null;
  noSendExpiryReclaimTxid?: string | null;
  noSendExpiryReclaimRawTx?: Bytes | null;
  noSendExpiryReclaimDerivationPrefix?: string | null;
  noSendExpiryReclaimDerivationSuffix?: string | null;
  noSendExpiryReclaimSatoshis?: number | null;
};
export type ReclaimStore = {
  findTransactions(a: { partial: Record<string, unknown>; trx?: unknown }): Promise<ExpiryRow[]>;
  findOutputs(a: {
    partial: Record<string, unknown>;
    trx?: unknown;
  }): Promise<{ lockingScript?: Bytes | null; satoshis?: number | null }[]>;
  findProvenTxReqs?(a: { partial: Record<string, unknown>; trx?: unknown }): Promise<{ rawTx?: Bytes | null }[]>;
  findProvenTxs?(a: { partial: Record<string, unknown>; trx?: unknown }): Promise<{ rawTx?: Bytes | null }[]>;
};
/** The locking script (hex) the wallet's own reclaim output has for this derivation. */
export type LockFor = (derivationPrefix: string, derivationSuffix: string) => string;

/** armReclaim's expected lock, from the wallet's own key deriver and change key pair. */
export function reclaimLockFor(wallet: {
  keyDeriver: unknown;
  getClientChangeKeyPair: () => { privateKey: string; publicKey: string };
}): LockFor {
  return (derivationPrefix, derivationSuffix) => {
    const keys = wallet.getClientChangeKeyPair();
    return new ScriptTemplateBRC29({ derivationPrefix, derivationSuffix, keyDeriver: wallet.keyDeriver as never })
      .lock(keys.privateKey, keys.publicKey)
      .toHex();
  };
}

const outpointOf = (i: Transaction['inputs'][number]) =>
  `${(i.sourceTXID ?? i.sourceTransaction?.id('hex') ?? '').toLowerCase()}.${i.sourceOutputIndex}`;
const parse = (raw: Bytes | null | undefined) => {
  try {
    return raw?.length ? Transaction.fromBinary(Array.from(raw)) : undefined;
  } catch {
    return undefined;
  }
};

/** The anchor transaction from this store's own bytes (its row, request or proven record) that hash to `txid`. */
async function anchorTxOf(sp: ReclaimStore, txid: string, trx?: unknown): Promise<Transaction | undefined> {
  const sources: (() => Promise<{ rawTx?: Bytes | null }[]>)[] = [
    () => sp.findTransactions({ partial: { txid }, trx }),
    ...(sp.findProvenTxReqs ? [() => sp.findProvenTxReqs!({ partial: { txid }, trx })] : []),
    ...(sp.findProvenTxs ? [() => sp.findProvenTxs!({ partial: { txid }, trx })] : []),
  ];
  for (const read of sources)
    for (const r of await read().catch(() => [])) {
      const tx = parse(r.rawTx);
      if (tx && tx.id('hex') === txid) return tx;
    }
  return undefined;
}

/** Why `t`'s reclaim is not the wallet's own, structurally; undefined when it is. Reads only; writes nothing. */
export async function checkReclaim(
  sp: ReclaimStore,
  t: ExpiryRow,
  lockFor: LockFor,
  trx?: unknown,
): Promise<string | undefined> {
  const target = String(t.txid ?? '').toLowerCase();
  const reclaimTxid = String(t.noSendExpiryReclaimTxid ?? '').toLowerCase();
  if (!target || !reclaimTxid) return 'no payment or reclaim txid';
  if (reclaimTxid === target) return 'the reclaim is the payment itself';
  const reclaim = parse(t.noSendExpiryReclaimRawTx);
  if (!reclaim) return 'the reclaim bytes do not parse';
  if (reclaim.id('hex') !== reclaimTxid) return 'the reclaim bytes are not the reclaim txid';
  const anchorTxid = String(t.noSendExpiryAnchorTxid ?? '').toLowerCase();
  const vout = t.noSendExpiryAnchorVout;
  if (!anchorTxid || typeof vout !== 'number') return 'no anchor';
  const anchor = `${anchorTxid}.${vout}`;
  if (reclaim.inputs.length !== 1 || outpointOf(reclaim.inputs[0]) !== anchor)
    return 'the reclaim spends something other than the anchor';
  const [row] = await sp.findOutputs({ partial: { txid: anchorTxid, vout }, trx });
  if (!row) return 'the anchor is not an output in this store';
  // The anchor's script and amount come from its own transaction's bytes (hashing to its txid), never from the
  // output row, which a backup could have written (review round 5, item 2).
  const anchorOut = (await anchorTxOf(sp, anchorTxid, trx))?.outputs[vout];
  if (!anchorOut || typeof anchorOut.satoshis !== 'number') return "the anchor transaction's bytes are not here";
  let targetTx = parse(t.rawTx);
  if (!targetTx && sp.findProvenTxReqs)
    targetTx = parse((await sp.findProvenTxReqs({ partial: { txid: target }, trx }))[0]?.rawTx);
  if (!targetTx || targetTx.id('hex') !== target) return 'the payment bytes are not here';
  if (!targetTx.inputs.some((i) => outpointOf(i) === anchor)) return 'the payment does not spend the anchor';
  const prefix = t.noSendExpiryReclaimDerivationPrefix;
  const suffix = t.noSendExpiryReclaimDerivationSuffix;
  if (!prefix || !suffix) return 'no reclaim derivation';
  if (reclaim.outputs.length !== 1) return 'the reclaim has more than one output';
  const out = reclaim.outputs[0];
  if (out.lockingScript.toHex() !== lockFor(prefix, suffix)) return "the reclaim doesn't pay this wallet's own key";
  if (typeof t.noSendExpiryReclaimSatoshis === 'number' && out.satoshis !== t.noSendExpiryReclaimSatoshis)
    return 'the reclaim amount is not the one recorded';
  try {
    const ok = new Spend({
      sourceTXID: anchorTxid,
      sourceOutputIndex: vout,
      sourceSatoshis: anchorOut.satoshis,
      lockingScript: LockingScript.fromBinary(anchorOut.lockingScript.toBinary()),
      transactionVersion: reclaim.version,
      otherInputs: [],
      outputs: reclaim.outputs,
      inputIndex: 0,
      unlockingScript: reclaim.inputs[0].unlockingScript!,
      inputSequence: reclaim.inputs[0].sequence ?? 0xffffffff,
      lockTime: reclaim.lockTime,
    }).validate();
    if (!ok) return 'the reclaim signature does not verify';
  } catch {
    return 'the reclaim signature does not verify';
  }
  return undefined;
}

/**
 * May `txid` go out as a reclaim? Every payment naming it as its reclaim is checked (the one 'reclaiming' first): it
 * passes when any of them passes (review round 5, item 1: a forged row that sorts first must not block a real one).
 * Undefined when it passes or is no payment's reclaim; else the first row's reason.
 */
export async function reclaimVerdict(sp: ReclaimStore, txid: string, lockFor: LockFor): Promise<string | undefined> {
  const rows = await sp.findTransactions({ partial: { noSendExpiryReclaimTxid: txid } });
  if (!rows.length) return undefined;
  const ordered = [...rows].sort(
    (a, b) => Number(b.noSendExpiryState === 'reclaiming') - Number(a.noSendExpiryState === 'reclaiming'),
  );
  let first: string | undefined;
  for (const t of ordered) {
    const why = await checkReclaim(sp, t, lockFor);
    if (!why) return undefined;
    first ??= why;
  }
  return first;
}

type ActivationStore = ReclaimStore & {
  compareAndSetNoSendExpiryState: (id: number, expected: string, next: string, trx?: unknown) => Promise<boolean>;
};
const GUARDED = Symbol.for('bwx.reclaimActivation');

/**
 * Wrap this device's store (in place): the toolbox's move of a payment to 'reclaiming' (the step before it inserts
 * and posts the reclaim) happens only when checkReclaim passes. Otherwise it answers "not moved": nothing is posted,
 * the row stays as it is, and the reason is logged once per payment. Idempotent; false without such a method.
 */
export function guardReclaimActivation(
  store: unknown,
  lockFor: LockFor,
  log: (m: string) => void = (m) => console.warn(m),
): boolean {
  const s = store as (ActivationStore & { [GUARDED]?: true }) | null;
  if (!s || typeof s.compareAndSetNoSendExpiryState !== 'function') return false;
  if (s[GUARDED]) return true;
  const original = s.compareAndSetNoSendExpiryState.bind(s);
  const logged = new Set<string>();
  s.compareAndSetNoSendExpiryState = async (id, expected, next, trx) => {
    if (next === 'reclaiming') {
      const [t] = await s.findTransactions({ partial: { transactionId: id }, trx });
      const why = t
        ? await checkReclaim(s, t, lockFor, trx).catch((e: unknown) => `the check failed: ${String(e)}`)
        : 'no such payment';
      if (why) {
        const key = `${t?.txid ?? id}|${why}`;
        if (!logged.has(key)) {
          logged.add(key);
          log(`[reclaimGuard] not reclaiming ${t?.txid ?? id}: ${why} (left as it is)`);
        }
        return false;
      }
    }
    return original(id, expected, next, trx);
  };
  s[GUARDED] = true;
  return true;
}
