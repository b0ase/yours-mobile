/**
 * The address the Receive screen shows must always count.
 *
 * Owner, 10 Oct 2026: $5 sent to the new $vexvoid account's receive address (13WRxSg…, BRC-29 deposit index 0)
 * sat unspent on chain and on the 1Sat indexer, yet the extension showed $0 after every sync, rescan and
 * unlock. The address sync skips any txid its processed-tx store already holds, and only counts a payment
 * once internalizeAction has written it to wallet storage, so one silent failure there hides the money
 * for good. This guard asks the indexer for unspent outputs at the wallet's own receive addresses, compares
 * them with the outputs wallet storage knows, retries the missing ones directly (bypassing the processed
 * store), and counts whatever is still missing as "arriving" so nobody sees $0 for money the wallet handed
 * them an address for.
 */

export interface ChainOutput {
  outpoint: string; // "txid.vout" or "txid_vout"
  satoshis: number;
  address: string;
}

export interface UncreditedResult {
  satoshis: number;
  outputs: ChainOutput[];
  txids: string[];
}

/** Normalise "txid.vout" / "txid_vout" to "txid.vout". */
export const normOutpoint = (o: string) => o.replace('_', '.');

/**
 * Outputs the wallet has already moved itself (receiveRescue.ts), so they are spent even while the indexer still
 * lists them as unspent: the spend sits in the mempool until the next block, and the owner sync only reports a
 * spendTxid once it is mined. Owner, 11 Oct 2026 (5.2.1): right after the rescue the card showed $9.84 for $4.92,
 * the new output plus the old one still counted as "arriving", and every site createAction re-ran the guard.
 */
const moved = new Map<string, number>();
/** How long a moved outpoint is remembered: long past the spend's first confirmation. */
export const MOVED_TTL_MS = 3 * 24 * 60 * 60 * 1000;
export function markMoved(outpoints: string[], at = Date.now()) {
  for (const o of outpoints) moved.set(normOutpoint(o), at);
}
export function isMoved(outpoint: string, now = Date.now()): boolean {
  const at = moved.get(normOutpoint(outpoint));
  if (at === undefined) return false;
  if (now - at > MOVED_TTL_MS) {
    moved.delete(normOutpoint(outpoint));
    return false;
  }
  return true;
}
/** Persistable form, for restoring after a service-worker restart. */
export const movedEntries = (): [string, number][] => [...moved.entries()];
export function restoreMoved(entries: unknown, now = Date.now()) {
  if (!Array.isArray(entries)) return;
  for (const e of entries)
    if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number' && now - e[1] <= MOVED_TTL_MS)
      moved.set(normOutpoint(e[0]), e[1]);
}

/** On-chain unspent outputs at our receive addresses that wallet storage does not hold. */
export function findUncredited(chain: ChainOutput[], walletOutpoints: Iterable<string>): UncreditedResult {
  const known = new Set(Array.from(walletOutpoints, normOutpoint));
  const outputs = chain.filter((o) => o.satoshis > 0 && !known.has(normOutpoint(o.outpoint)) && !isMoved(o.outpoint));
  return {
    satoshis: outputs.reduce((t, o) => t + o.satoshis, 0),
    outputs,
    txids: [...new Set(outputs.map((o) => normOutpoint(o.outpoint).split('.')[0]))],
  };
}

interface OwnerSyncOutput {
  outpoint: string;
  score?: number;
  spendTxid?: string;
  satoshis?: number;
}

export interface GuardDeps {
  /** The indexer's owner sync stream (services.owner.sync) — unspent and spent outputs at the given addresses. */
  ownerSync: (addresses: string[]) => AsyncIterable<OwnerSyncOutput>;
  /** Satoshis of one output, when the stream doesn't carry them (raw tx lookup). */
  outputSats: (outpoint: string) => Promise<number>;
  /** The outpoints wallet storage lists as spendable (listOutputs over the wallet's baskets). */
  walletOutpoints: () => Promise<string[]>;
  /**
   * Of these outpoints, the ones storage already accounts for though listOutputs no longer lists them: spent by one of
   * the wallet's own transactions that is out or going out (services/heldOutpoints.ts). Owner, 5 Nov 2026: the deposit
   * sweep spent the payment, listOutputs dropped it, the indexer still listed it unspent, and it counted twice.
   */
  accountedFor?: (outpoints: string[]) => Promise<Iterable<string>>;
}

/**
 * The indexer's owner stream sends one row per state of an outpoint (seen in the mempool, mined, spent), so one outpoint
 * can come several times. One entry each; spent when any of its rows names a spender.
 */
export function latestState<T extends { outpoint: string; spendTxid?: string }>(
  rows: Iterable<T>,
): Map<string, T & { spendTxid?: string }> {
  const out = new Map<string, T & { spendTxid?: string }>();
  for (const r of rows) {
    const k = normOutpoint(r.outpoint);
    const had = out.get(k);
    out.set(k, { ...(had ?? r), ...r, outpoint: k, spendTxid: had?.spendTxid || r.spendTxid || undefined });
  }
  return out;
}

/** Ask the indexer about our receive addresses and report what wallet storage is missing. */
export async function checkReceiveAddresses(addresses: string[], deps: GuardDeps): Promise<UncreditedResult> {
  const unique = [...new Set(addresses.filter(Boolean))];
  if (!unique.length) return { satoshis: 0, outputs: [], txids: [] };
  const rows: OwnerSyncOutput[] = [];
  for await (const o of deps.ownerSync(unique)) rows.push(o);
  const known = new Set(Array.from(await deps.walletOutpoints(), normOutpoint));
  let candidates = [...latestState(rows).values()].filter(
    (o) => !o.spendTxid && !known.has(o.outpoint) && !isMoved(o.outpoint),
  );
  if (candidates.length && deps.accountedFor) {
    const accounted = new Set(Array.from(await deps.accountedFor(candidates.map((o) => o.outpoint)), normOutpoint));
    candidates = candidates.filter((o) => !accounted.has(o.outpoint));
  }
  const chain: ChainOutput[] = [];
  for (const o of candidates) {
    const satoshis = typeof o.satoshis === 'number' ? o.satoshis : await deps.outputSats(o.outpoint);
    chain.push({ outpoint: o.outpoint, satoshis, address: '' });
  }
  return findUncredited(chain, known);
}

// ── What the balance adds for money on chain that storage does not count yet ──

/**
 * Outputs on chain at our receive addresses that storage did not hold when last checked ("arriving"). Kept as outpoints,
 * not a number: every balance read asks storage again and drops the ones it now holds (arrivingNow), so a payment the
 * address sync or the receive watcher has since taken in is never counted twice. Owner, 5 Nov 2026: the old number
 * stayed until the next guard run, on top of the deposit (and then the sweep) that held the same dollar.
 */
const arriving = new Map<string, number>();
/** Replace the list with the guard's latest result. */
export const setArriving = (outputs: ChainOutput[]) => {
  arriving.clear();
  addArriving(outputs);
};
/** Add outputs seen on chain that storage does not hold yet (the receive watcher, while it takes them in). */
export const addArriving = (outputs: ChainOutput[]) => {
  for (const o of outputs) if (o.satoshis > 0) arriving.set(normOutpoint(o.outpoint), o.satoshis);
};
/** Forget outputs that are spent on chain or now in storage. */
export const dropArriving = (outpoints: Iterable<string>) => {
  for (const o of outpoints) arriving.delete(normOutpoint(o));
};
/** The last known arriving total (for messages; the balance uses arrivingNow). */
export const arrivingSats = () => [...arriving.values()].reduce((t, s) => t + s, 0);
export const arrivingOutputs = (): ChainOutput[] =>
  [...arriving].map(([outpoint, satoshis]) => ({ outpoint, satoshis, address: '' }));

/**
 * Receipts seen in the mempool and not yet mined (the receive watcher notes them). They are part of the balance like any
 * other money storage holds; the card shows them as "pending" until a block has them. Forgotten when the watcher sees
 * them mined, or after UNCONFIRMED_TTL_MS so a watcher that stopped never leaves "pending" up for good.
 */
const unconfirmed = new Map<string, { satoshis: number; at: number }>();
export const UNCONFIRMED_TTL_MS = 2 * 60 * 60 * 1000;
export const noteUnconfirmed = (outputs: ChainOutput[], at = Date.now()) => {
  for (const o of outputs) if (o.satoshis > 0) unconfirmed.set(normOutpoint(o.outpoint), { satoshis: o.satoshis, at });
};
export const noteConfirmed = (outpoints: Iterable<string>) => {
  for (const o of outpoints) unconfirmed.delete(normOutpoint(o));
};
export const unconfirmedOutpoints = () => [...unconfirmed.keys()];

/**
 * What the balance adds now for money storage does not count, and how much of the balance is pending. `accountedFor`
 * names the outpoints storage now counts (services/heldOutpoints.ts); without it, or if it fails, arriving counts as
 * before. counted: arriving outputs storage still lacks. pending: those, plus unconfirmed receipts storage holds.
 */
export async function arrivingNow(
  accountedFor?: (outpoints: string[]) => Promise<Iterable<string>>,
  now = Date.now(),
): Promise<{ counted: number; pending: number }> {
  for (const [k, u] of unconfirmed) if (now - u.at > UNCONFIRMED_TTL_MS) unconfirmed.delete(k);
  const asked = [...new Set([...arriving.keys(), ...unconfirmed.keys()])];
  let held = new Set<string>();
  if (asked.length && accountedFor) {
    try {
      held = new Set(Array.from(await accountedFor(asked), normOutpoint));
    } catch {
      /* storage can't say: arriving counts as it did, unconfirmed shows nothing */
    }
  }
  let counted = 0;
  let pending = 0;
  for (const [k, sats] of [...arriving]) {
    if (held.has(k)) {
      arriving.delete(k); // storage holds it now: counted there
      continue;
    }
    counted += sats;
    pending += sats;
  }
  for (const [k, u] of unconfirmed) if (held.has(k)) pending += u.satoshis;
  return { counted, pending };
}

/** Tests only. */
export const _resetReceiveState = () => {
  arriving.clear();
  unconfirmed.clear();
  moved.clear();
};
