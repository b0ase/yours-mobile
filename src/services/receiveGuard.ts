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

import { spentIn, type SpendCheck } from './spendCheck';

export interface ChainOutput {
  outpoint: string; // "txid.vout" or "txid_vout"
  satoshis: number;
  address: string;
  /**
   * Spent on chain by this transaction, which this device holds with its change still waiting for admission: counted
   * until that change counts (review 20 re-check, M5).
   */
  spender?: string;
}

export interface UncreditedResult {
  satoshis: number;
  outputs: ChainOutput[];
  txids: string[];
  /** Spenders the spend check named for outputs the owner stream still listed unspent (left out of the result). */
  spenders?: string[];
}

/** Normalise "txid.vout" / "txid_vout" to "txid.vout". */
export const normOutpoint = (o: string) => o.replace('_', '.');

/**
 * Can this output be BSV money? More than 1 sat. A 1-sat output is an ordinal: an inscription, a token, a name or a bare
 * marker (a Store receipt, say). The coin intake never takes one in as BSV (prioritySyncRun.ts coinOutputs), so the
 * balance must never add one as "arriving" either. Owner, 13 Nov 2026: the extension showed 9,532,115 sats while storage
 * held 9,532,114 and the iPhone showed 9,532,114; the extra sat was a 1-sat output at a receive address that storage
 * holds in no basket the guard reads (or as an unadmitted ordinal), counted as arriving on every balance read.
 */
export const isCoinSats = (satoshis: number | undefined): boolean =>
  typeof satoshis === 'number' && Number.isFinite(satoshis) && satoshis > 1;

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
  /**
   * Spent already, mempool included (services/spendCheck.ts)? The owner stream lists a spend only once it is mined, so a
   * payment the other copy of this wallet swept seconds ago still looks unspent there (review 20, H1 and M2: with the
   * remote store active, nothing else stopped it counting on top of the sweep's change).
   */
  spends?: SpendCheck;
  /**
   * Of the spenders the spend check names, the ones this device holds whose change still waits for admission
   * (services/heldOutpoints.ts waitingVia). Their payments stay "arriving", tagged with the spender, until that change
   * is admitted; any other named spender drops the payment (review 20 re-check, M5).
   */
  waitingSpenders?: (spenders: string[]) => Promise<Iterable<string>>;
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
  let spenders: string[] = [];
  const spentBy = new Map<string, string>();
  if (candidates.length && deps.spends) {
    const answer = await deps.spends(candidates.map((o) => o.outpoint)).catch(() => new Map<string, string | null>());
    const named = spentIn(
      answer,
      candidates.map((o) => o.outpoint),
    );
    spenders = named.spenders;
    const waiting = new Set(
      named.spenders.length && deps.waitingSpenders
        ? await Promise.resolve(deps.waitingSpenders(named.spenders)).catch(() => [] as string[])
        : [],
    );
    for (const o of named.spent) {
      const by = answer.get(o) as string;
      if (waiting.has(by)) spentBy.set(o, by);
    }
    const gone = new Set(named.spent.filter((o) => !spentBy.has(o)));
    candidates = candidates.filter((o) => !gone.has(o.outpoint));
  }
  const chain: ChainOutput[] = [];
  for (const o of candidates) {
    const satoshis = typeof o.satoshis === 'number' ? o.satoshis : await deps.outputSats(o.outpoint);
    const spender = spentBy.get(o.outpoint);
    chain.push({ outpoint: o.outpoint, satoshis, address: '', ...(spender ? { spender } : {}) });
  }
  return { ...findUncredited(chain, known), spenders };
}

// ── What the balance adds for money on chain that storage does not count yet ──

/**
 * Outputs on chain at our receive addresses that storage did not hold when last checked ("arriving"). Kept as outpoints,
 * not a number: every balance read asks storage again and drops the ones it now holds (arrivingNow), so a payment the
 * address sync or the receive watcher has since taken in is never counted twice. Owner, 5 Nov 2026: the old number
 * stayed until the next guard run, on top of the deposit (and then the sweep) that held the same dollar.
 */
const arriving = new Map<string, { satoshis: number; at: number; spender?: string }>();
/**
 * The guard's latest result. `since`: when its look at the indexer began. Entries added after that (the receive watcher,
 * meanwhile) are kept even if the result lacks them (review 20, L2: a stale "nothing missing" wiped the watcher's entry
 * before its take() landed, so the payment counted nowhere). Without `since`, the list is replaced.
 */
export const setArriving = (outputs: ChainOutput[], since?: number) => {
  const keep = new Set(outputs.map((o) => normOutpoint(o.outpoint)));
  for (const [k, e] of [...arriving]) if (!keep.has(k) && (since === undefined || e.at < since)) arriving.delete(k);
  addArriving(outputs);
};
/** Add outputs seen on chain that storage does not hold yet (the receive watcher, while it takes them in). */
export const addArriving = (outputs: ChainOutput[], at = Date.now()) => {
  for (const o of outputs) {
    const k = normOutpoint(o.outpoint);
    // Only money: a 1-sat ordinal / marker is never BSV (isCoinSats).
    if (isCoinSats(o.satoshis))
      arriving.set(k, {
        satoshis: o.satoshis,
        at: arriving.get(k)?.at ?? at,
        ...(o.spender ? { spender: o.spender } : {}),
      });
  }
};
/**
 * Forget outputs that are spent on chain or now in storage. `keepWaiting`: not those the guard keeps because their
 * spender's change waits here for admission (the balance drops them once it counts).
 */
export const dropArriving = (outpoints: Iterable<string>, o: { keepWaiting?: boolean } = {}) => {
  for (const op of outpoints) {
    const k = normOutpoint(op);
    if (o.keepWaiting && arriving.get(k)?.spender) continue;
    arriving.delete(k);
  }
};
/** Of `outputs`, those the balance may count as arriving money (more than 1 sat), and their total. */
export const arrivingCoins = (outputs: ChainOutput[]): { outputs: ChainOutput[]; satoshis: number } => {
  const coins = outputs.filter((o) => isCoinSats(o.satoshis));
  return { outputs: coins, satoshis: coins.reduce((t, o) => t + o.satoshis, 0) };
};
/** The last known arriving total (for messages; the balance uses arrivingNow). */
export const arrivingSats = () => [...arriving.values()].reduce((t, e) => t + e.satoshis, 0);
export const arrivingOutputs = (): ChainOutput[] =>
  [...arriving].map(([outpoint, e]) => ({ outpoint, satoshis: e.satoshis, address: '', spender: e.spender }));

/**
 * Receipts seen in the mempool and not yet mined (the receive watcher notes them). They are part of the balance like any
 * other money storage holds; the card shows them as "pending" until a block has them. Forgotten when the watcher sees
 * them mined, or after UNCONFIRMED_TTL_MS so a watcher that stopped never leaves "pending" up for good.
 */
const unconfirmed = new Map<string, { satoshis: number; at: number }>();
export const UNCONFIRMED_TTL_MS = 2 * 60 * 60 * 1000;
export const noteUnconfirmed = (outputs: ChainOutput[], at = Date.now()) => {
  for (const o of outputs)
    if (isCoinSats(o.satoshis)) unconfirmed.set(normOutpoint(o.outpoint), { satoshis: o.satoshis, at });
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
/**
 * Of the arriving and unconfirmed outpoints, the ones storage counts now (a failed read: none). `spenderCarries`: of the
 * spenders arriving entries are tagged with, the ones whose change here counts now: those entries are held too.
 */
export async function arrivingHeld(
  accountedFor?: (outpoints: string[]) => Promise<Iterable<string>>,
  spenderCarries?: (spenders: string[]) => Promise<Iterable<string>>,
): Promise<Set<string>> {
  const held = new Set<string>();
  const asked = [...new Set([...arriving.keys(), ...unconfirmed.keys()])];
  if (asked.length && accountedFor) {
    try {
      for (const o of await accountedFor(asked)) held.add(normOutpoint(o));
    } catch {
      /* storage can't say: arriving counts as it did, unconfirmed shows nothing */
    }
  }
  const tagged = [...arriving].filter(([, e]) => !!e.spender);
  if (tagged.length && spenderCarries) {
    try {
      const carries = new Set(await spenderCarries([...new Set(tagged.map(([, e]) => e.spender!))]));
      for (const [k, e] of tagged) if (carries.has(e.spender!)) held.add(k);
    } catch {
      /* can't tell: counted as before */
    }
  }
  return held;
}

export async function arrivingNow(
  accountedFor?: (outpoints: string[]) => Promise<Iterable<string>>,
  now = Date.now(),
  /** Held at an earlier check of the same balance read (balanceSplit checks before and after its storage reads). */
  heldBefore: Set<string> = new Set(),
  spenderCarries?: (spenders: string[]) => Promise<Iterable<string>>,
): Promise<{ counted: number; pending: number }> {
  for (const [k, u] of unconfirmed) if (now - u.at > UNCONFIRMED_TTL_MS) unconfirmed.delete(k);
  const held = await arrivingHeld(accountedFor, spenderCarries);
  for (const k of heldBefore) held.add(k);
  let counted = 0;
  let pending = 0;
  for (const [k, e] of [...arriving]) {
    if (held.has(k) || !isCoinSats(e.satoshis)) {
      arriving.delete(k); // storage holds it now (counted there), or it is a 1-sat ordinal, never BSV
      continue;
    }
    counted += e.satoshis;
    pending += e.satoshis;
  }
  for (const [k, u] of unconfirmed) if (held.has(k) && isCoinSats(u.satoshis)) pending += u.satoshis;
  return { counted, pending };
}

/** Tests only. */
export const _resetReceiveState = () => {
  arriving.clear();
  unconfirmed.clear();
  moved.clear();
};
