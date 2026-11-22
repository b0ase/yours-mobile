/**
 * A BEEF carries only what its transaction needs (task 54 review, round 2; b-Aware 310/316).
 *
 * The toolbox merges a proof request's inputBEEF into every BEEF it builds for a payment that spends that request's
 * outputs (getValidBeefForTxid), and postBeef hands the whole BEEF to the broadcaster, which processes every unproven
 * transaction in it. So a payment signed and withheld (noSend) that a hostile backup slips into another payment's
 * inputBEEF went out with this device's next ordinary send. Two checks close it:
 *  - pulled rows (services/inboundSync.ts): a request's or transaction's raw bytes must hash to its txid, and its
 *    inputBEEF keeps only the ancestors of those bytes (`ancestorsOnly`);
 *  - every broadcast (`guardPostBeef`, installed by initWallet): the BEEF posted keeps only the transactions named and
 *    their ancestors (`pruneBeef`).
 * An ancestor is followed through the BEEF until it has a proof (or is a txid-only entry): proven transactions are on
 * chain already, and nothing past them is needed.
 */
import { Beef, MerklePath, Transaction, type ChainTracker } from '@bsv/sdk';

type Bytes = ArrayLike<number>;

/** The txid these raw bytes hash to, or undefined when they don't parse as a transaction. */
export function txidOfRaw(raw: Bytes | null | undefined): string | undefined {
  if (!raw || !raw.length) return undefined;
  try {
    return Transaction.fromBinary(Array.from(raw)).id('hex');
  } catch {
    return undefined;
  }
}

const sourceOf = (i: Transaction['inputs'][number]): string | undefined =>
  i.sourceTXID ?? i.sourceTransaction?.id('hex');

/** The txids in `beef` that `from` (txids, or a transaction's inputs) reaches, following unproven transactions only. */
function reachable(beef: Beef, from: string[]): Set<string> {
  const keep = new Set<string>();
  const stack = [...from];
  while (stack.length) {
    const id = stack.pop()!;
    if (keep.has(id)) continue;
    const b = beef.findTxid(id);
    if (!b) continue;
    keep.add(id);
    if (b.hasProof || !b.tx) continue;
    for (const i of b.tx.inputs) {
      const s = sourceOf(i);
      if (s) stack.push(s);
    }
  }
  return keep;
}

/** Drop every transaction of `beef` not in `keep`, in place. Returns how many went. */
function dropAllBut(beef: Beef, keep: Set<string>): number {
  let n = 0;
  for (const b of [...beef.txs])
    if (!keep.has(b.txid)) {
      beef.removeExistingTxid(b.txid);
      n++;
    }
  return n;
}

/**
 * An inputBEEF cut to the ancestors of `rawTx` (and `rawTx` itself, if it is there): bytes unchanged when nothing goes,
 * new bytes when something does, and undefined when either can't be read (the caller clears the inputBEEF).
 */
export function ancestorsOnly(inputBEEF: Bytes, rawTx: Bytes | null | undefined): number[] | undefined {
  if (!rawTx || !rawTx.length) return undefined;
  let tx: Transaction;
  let beef: Beef;
  try {
    tx = Transaction.fromBinary(Array.from(rawTx));
    beef = Beef.fromBinary(Array.from(inputBEEF));
  } catch {
    return undefined;
  }
  const keep = reachable(
    beef,
    tx.inputs.map(sourceOf).filter((s): s is string => !!s),
  );
  keep.add(tx.id('hex'));
  return dropAllBut(beef, keep) ? beef.toBinary() : Array.from(inputBEEF);
}

/**
 * The BEEF to post for `txids`: those transactions and their ancestors only, as a copy (the caller's BEEF is left as
 * it was). `dropped` lists the txids left out.
 */
export function pruneBeef(beef: Beef, txids: string[]): { beef: Beef; dropped: string[] } {
  const keep = reachable(beef, txids);
  const dropped = beef.txs.map((b) => b.txid).filter((t) => !keep.has(t));
  if (!dropped.length) return { beef, dropped };
  const copy = beef.clone();
  dropAllBut(copy, keep);
  return { beef: copy, dropped };
}

type PostBeef = (beef: Beef, txids: string[], ...rest: unknown[]) => Promise<unknown>;
const GUARDED = Symbol.for('bwx.postBeef.ancestorsOnly');

export type PostGuard = {
  /**
   * True when this device holds the transaction back: signed noSend here (its transaction or proof request is
   * 'nosend'). An error counts as held (the post is refused).
   */
  held?: (txid: string) => Promise<boolean>;
  /** True when this device's own action released it (services/releaseMarks.ts). */
  released?: (txid: string) => boolean;
  /**
   * True when the network already has it in a block (knownByServices): posting it again sends nothing new. Asked only
   * for a held, unreleased transaction; an error counts as not known (refused).
   */
  known?: (txid: string) => Promise<boolean>;
  /**
   * Why a posted transaction may not go out as a BRC-177 reclaim (services/reclaimGuard.ts checkReclaim), or undefined
   * when it is no reclaim or a sound one. An error refuses.
   */
  reclaim?: (txid: string) => Promise<string | undefined>;
  log?: (m: string) => void;
};

/** The store reads heldOnDevice needs (a StorageProvider: StorageIdb). */
export type HeldTxStore = {
  findProvenTxReqs(a: { partial: Record<string, unknown> }): Promise<{ status?: string }[]>;
  findTransactions(a: { partial: Record<string, unknown>; noRawTx?: boolean }): Promise<{ status?: string }[]>;
};

type ChainServices = {
  getMerklePath?: (txid: string) => Promise<unknown>;
  getChainTracker?: () => Promise<unknown>;
};

/**
 * The network has `txid` in a block: a merkle path the services return for it, checked against the wallet's own chain
 * tracker (review round 4, item 5). A mempool "known", a path that doesn't check, or any error is no: a held payment
 * stays held until it is really mined (CheckNoSends then completes it).
 */
export async function knownByServices(services: ChainServices, txid: string): Promise<boolean> {
  if (typeof services.getMerklePath !== 'function' || typeof services.getChainTracker !== 'function') return false;
  const r = (await services.getMerklePath(txid)) as { merklePath?: MerklePath | MerklePath[] } | undefined;
  const path = Array.isArray(r?.merklePath) ? r.merklePath[0] : r?.merklePath;
  if (!path || typeof (path as MerklePath).computeRoot !== 'function') return false;
  // Inclusion only: the root this path gives for the txid is a block's at that height (MerklePath.verify also applies
  // the coinbase 100-block rule to offset 0, which is about spending a coinbase, not about being mined).
  let root: string;
  try {
    if ((path as MerklePath).indexOf(txid) == null) return false;
    root = (path as MerklePath).computeRoot(txid);
  } catch {
    return false;
  }
  const tracker = (await services.getChainTracker()) as ChainTracker;
  return (await tracker.isValidRootForHeight(root, (path as MerklePath).blockHeight)) === true;
}

/** Is `txid` held on this device: its proof request or a transaction row of it 'nosend' (signed noSend here)? */
export async function heldOnDevice(sp: HeldTxStore, txid: string): Promise<boolean> {
  if ((await sp.findProvenTxReqs({ partial: { txid } })).some((q) => q.status === 'nosend')) return true;
  return (await sp.findTransactions({ partial: { txid }, noRawTx: true })).some((t) => t.status === 'nosend');
}

/**
 * `held` for guardPostBeef from this device's own records only (review round 4, item 6): its record of payments it
 * signed noSend (services/releaseMarks.ts) or, when it has one, its own store's rows. Never the active store's, which
 * may be remote and say anything.
 */
export function heldLocally(
  marks: { heldHere: (txid: string) => boolean },
  own: () => HeldTxStore | undefined,
): (txid: string) => Promise<boolean> {
  return async (txid) => {
    if (marks.heldHere(txid)) return true;
    const s = own();
    return s ? heldOnDevice(s, txid) : false;
  };
}

/** What a refused post answers: a service error for every txid (nothing is failed; the send stays queued). */
export const REFUSED_HELD = 'a payment held on this device (signed noSend) was not released for broadcast';
const refusal = (txids: string[]) => [
  {
    name: 'bwx-release-guard',
    status: 'error',
    error: new Error(REFUSED_HELD),
    txidResults: txids.map((txid) => ({ txid, status: 'error', serviceError: true })),
  },
];

/**
 * Unproven transactions in `beef` held on this device, not released by it, and unknown to the network (review round
 * 3, F1b). Each is a payment signed noSend here that something other than this device's own action is trying to send.
 */
export async function heldUnreleased(beef: Beef, guard: PostGuard): Promise<string[]> {
  if (!guard.held) return [];
  const out: string[] = [];
  for (const b of beef.txs) {
    if (b.hasProof || !b.tx || guard.released?.(b.txid)) continue;
    const held = await guard.held(b.txid).catch(() => true);
    if (!held) continue;
    if (guard.known && (await guard.known(b.txid).catch(() => false))) continue;
    out.push(b.txid);
  }
  return out;
}

/**
 * Wrap services.postBeef: every BEEF goes out holding only the transactions it names and their ancestors, so no
 * transaction riding in it reaches the network; and the whole post is refused when any unproven transaction left in
 * it is held on this device without this device's release (`guard`). Idempotent; false when there is no postBeef.
 */
export function guardPostBeef(services: unknown, guard: PostGuard = {}): boolean {
  const s = services as ({ postBeef?: PostBeef } & { [GUARDED]?: true }) | null;
  if (!s || typeof s.postBeef !== 'function') return false;
  if (s[GUARDED]) return true;
  const log = guard.log ?? ((m: string) => console.warn(m));
  const original = s.postBeef.bind(s);
  s.postBeef = async (beef: Beef, txids: string[], ...rest: unknown[]) => {
    if (!beef || typeof beef.findTxid !== 'function' || !Array.isArray(txids)) return original(beef, txids, ...rest);
    const pruned = pruneBeef(beef, txids);
    if (pruned.dropped.length)
      log(`[postBeef] left ${pruned.dropped.length} transaction(s) that are not ancestors out of the broadcast`);
    for (const t of guard.reclaim ? txids : []) {
      const why = await guard.reclaim!(t).catch((e: unknown) => `the check failed: ${String(e)}`);
      if (why) {
        log(`[postBeef] refused the reclaim ${t}: ${why}`);
        return refusal(txids);
      }
    }
    const held = await heldUnreleased(pruned.beef, guard);
    if (held.length) {
      log(
        `[postBeef] refused: ${held.length} transaction(s) held on this device and not released (${held.join(', ')})`,
      );
      return refusal(txids);
    }
    return original(pruned.beef, txids, ...rest);
  };
  s[GUARDED] = true;
  return true;
}
