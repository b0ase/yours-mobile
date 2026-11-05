/**
 * Instant receive (owner, 5 Nov 2026: the iPhone showed neither of two $1 payments after 20+ minutes in front; the
 * extension took them in only on its 60 s address-sync alarm, behind a 45 s gate, re-reading all history each time).
 *
 * While the app or extension UI is in front (APP_FOREGROUND, renewed every 30 s; APP_BACKGROUND stops it), every ~3 s
 * this asks the 1Sat indexer (the same owner-sync stream the address sync reads) about the wallet's receive addresses
 * only, from two blocks below the tip: everything mined in the last ~20 minutes and everything not mined yet.
 *  - A new unspent output storage has no row for is classified first, without downloading it when it can be helped
 *    (names and other 1-sat items are left to the address sync; review 20, M4), then checked against the spend index,
 *    which sees mempool spends (review 20, H1: the owner stream lists a payment unspent until its sweep is mined, so the
 *    other copy of this wallet took in a payment the extension had already swept). A real, unspent payment is taken in
 *    through the address sync's own coin intake (prioritySyncRun.ts makeCoinIntake: shared internalize lock, recorded
 *    in the processed-tx store so the full sync skips it), shown at once as pending meanwhile. Nothing is swept here.
 *  - One of our receive outputs spent by a transaction this wallet does not hold: another copy took it. A device-sync
 *    pull runs at once (throttled), so its change arrives through the backup, under the inbound guard.
 *  - A receipt seen mined is no longer pending; an output spent on chain is no longer "arriving".
 * A look that fails backs off (3 s doubling to 60 s, longer after a 429); a stream that runs out of time is aborted; the
 * tip lookup has a deadline (review 20, M3). Only while this device's store is active.
 */
import type { OutpointState } from './heldOutpoints';
import type { CoinIntake } from './prioritySyncRun';
import {
  addArriving,
  dropArriving,
  latestState,
  normOutpoint,
  noteConfirmed,
  noteUnconfirmed,
  unconfirmedOutpoints,
  type ChainOutput,
} from './receiveGuard';
import { spentIn, type SpendCheck } from './spendCheck';

export const WATCH_INTERVAL_MS = 3_000;
/** A foreground lease: the page renews it every 30 s while visible; a page that vanished stops the watcher by itself. */
export const FOREGROUND_LEASE_MS = 75_000;
/** At most one device-sync pull this often. */
export const PULL_THROTTLE_MS = 10_000;
/** Pulls asked for one unknown spender (the other device pushes ~20 s after its change), then the usual paths. */
export const PULL_TRIES = 6;
/** Blocks below the tip to ask from: mined events are scored by height, unmined ones by unix time (always newer). */
export const WATCH_BLOCKS_BACK = 2;
/** The indexer scores a mined event by block height and an unmined one by unix seconds: below this, it is in a block. */
export const BLOCK_SCORE_MAX = 500_000_000;
/** One look at the indexer gives up after this (the request is aborted); the next look asks again. */
export const STREAM_TIMEOUT_MS = 10_000;
/** The tip lookup gives up after this; the look then asks for unmined events of the last 15 minutes. */
export const FROM_DEADLINE_MS = 5_000;
/** After a failed look: 3 s doubling up to this; a 429 starts at RATE_LIMITED_MS. */
export const MAX_BACKOFF_MS = 60_000;
export const RATE_LIMITED_MS = 15_000;
/** Transaction downloads (BEEF) per look: payments are found by classification first, then fetched a few at a time. */
export const FETCHES_PER_LOOK = 3;

/** The `from` score to ask with: two blocks below the tip, or (tip unknown) unmined events of the last 15 minutes. */
export const watchFrom = (height: number | undefined, nowMs: number): number =>
  height && height > WATCH_BLOCKS_BACK ? height - WATCH_BLOCKS_BACK : Math.floor(nowMs / 1000) - 15 * 60;

export type WatchRow = { outpoint: string; score?: number; spendTxid?: string };

export const isRateLimited = (e: unknown): boolean =>
  (e as { status?: number } | null)?.status === 429 ||
  /\b429\b|too many requests|rate.?limit/i.test(e instanceof Error ? e.message : String(e));

/** Delay before the next look after `failures` failed looks in a row (0: the normal interval). */
export const lookDelay = (failures: number, rateLimited: boolean): number =>
  failures <= 0
    ? WATCH_INTERVAL_MS
    : Math.min(MAX_BACKOFF_MS, (rateLimited ? RATE_LIMITED_MS : WATCH_INTERVAL_MS) * 2 ** (failures - 1));

/**
 * Ask for a device-sync pull because another copy of this wallet spent one of our receive outputs: at most once every
 * PULL_THROTTLE_MS, and at most PULL_TRIES times per spender (the other device pushes ~20 s after its change). Shared by
 * the watcher, the coin intake and the receive guard. `spenders` are txids this wallet does not hold. True when asked.
 */
export function createPullTrigger(d: {
  pull: () => Promise<unknown>;
  now?: () => number;
  log?: (...a: unknown[]) => void;
}) {
  const now = d.now ?? Date.now;
  const tries = new Map<string, number>();
  let lastAt = -Infinity;
  return (spenders: string[]): boolean => {
    const due = [...new Set(spenders)].filter((t) => (tries.get(t) ?? 0) < PULL_TRIES);
    if (!due.length || now() - lastAt < PULL_THROTTLE_MS) return false;
    lastAt = now();
    for (const t of due) tries.set(t, (tries.get(t) ?? 0) + 1);
    d.log?.(`[receiveWatch] receive output(s) spent by ${due[0]}… which this wallet does not hold: pulling the backup`);
    void d.pull().catch((e: unknown) => d.log?.('[receiveWatch] pull failed:', e));
    return true;
  };
}

/**
 * The 1Sat owner-sync stream read with an AbortSignal (OwnerClient.sync takes none, so a hung response stayed open after
 * the watcher gave up on it: review 20, M3). Same endpoint and rows; a non-2xx answer throws with its status.
 */
export function ownerSyncReader(baseUrl: string, fetchFn: typeof fetch = (u, i) => fetch(u, i)) {
  return async function* (addresses: string[], from: number, signal: AbortSignal): AsyncGenerator<WatchRow> {
    const q = new URLSearchParams();
    for (const a of addresses) q.append('owner', a);
    q.set('from', String(from));
    const r = await fetchFn(`${baseUrl.replace(/\/$/, '')}/sync?${q.toString()}`, { signal });
    if (!r.ok) throw Object.assign(new Error(`owner sync ${r.status}`), { status: r.status });
    const reader = r.body?.getReader();
    if (!reader) throw new Error('owner sync: no body');
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          let event = '';
          let data = '';
          for (const line of part.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data = line.slice(6);
          }
          if (event === 'done') return;
          if (event === 'error') throw new Error(data || 'owner sync error');
          if (!event && data) yield JSON.parse(data) as WatchRow;
        }
      }
    } finally {
      reader.releaseLock();
    }
  };
}

/** Per transaction: 'coin' pays us a plain coin; 'not-coin' does not (names, tokens); 'later' not classified yet. */
export type TxClass = 'coin' | 'not-coin' | 'later';

export type ReceiveWatchDeps = {
  /** This device's store is active, the wallet open, no site mid-action: otherwise the watcher does nothing. */
  active: () => boolean;
  /** The receive addresses (the Receive screen's address and the deposit addresses handed out). */
  addresses: () => string[];
  /** The `from` score for the indexer (watchFrom). Given FROM_DEADLINE_MS. */
  from: () => Promise<number>;
  /** The owner-sync rows for these addresses from `from`; aborted through `signal` when the look runs out of time. */
  stream: (addresses: string[], from: number, signal: AbortSignal) => AsyncIterable<WatchRow>;
  /** What storage holds for each outpoint (services/heldOutpoints.ts). */
  states: (outpoints: string[]) => Promise<Map<string, OutpointState>>;
  /** Of these txids, the ones storage holds a transaction for. */
  knownTxids: (txids: string[]) => Promise<Set<string>>;
  /** The processed-tx store already has this txid (the full sync took it in). */
  processed: (txid: string) => Promise<boolean>;
  /**
   * Which of these transactions pay us a plain coin, as cheaply as can be told (review 20, M4): the address sync's
   * classified store, the indexer's tags, then the raw transaction; never the full BEEF. `outpoints` per txid.
   */
  classify: (txids: string[], outpoints: Map<string, string[]>) => Promise<Map<string, TxClass>>;
  /** Spent already, mempool included (services/spendCheck.ts). */
  spends: SpendCheck;
  /** Another copy of this wallet spent these: a throttled device-sync pull (createPullTrigger). */
  askPull: (spenders: string[]) => boolean;
  fetchBeef: (txid: string) => Promise<number[]>;
  /** The address sync's coin intake (prioritySyncRun.ts makeCoinIntake); made on first use (it derives the keys). */
  intake: () => Promise<Pick<CoinIntake, 'coins' | 'take'>>;
  /** The balance changed (shown pending, or taken in): the UI reads it now. */
  changed: (found: number) => void;
  /** Per-transaction back-off for one that will not come in (services/internalizeBackoff.ts; review 20, L4). */
  backoff?: { due(txid: string): boolean; fail(txid: string, err?: unknown): number; clear(txid: string): void };
  /** Tests only: shorter STREAM_TIMEOUT_MS / FROM_DEADLINE_MS. */
  timeouts?: { streamMs?: number; fromMs?: number };
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  log?: (...a: unknown[]) => void;
};

export type WatchTick = {
  /** Why nothing was asked, when nothing was. */
  skipped?: 'background' | 'inactive' | 'failed' | 'no-addresses';
  /** Transactions taken in by this look. */
  taken: number;
  /** Outputs shown as pending by this look. */
  shown: number;
  /** A device-sync pull was asked for. */
  pulled: boolean;
  /** Payment outputs left out because they were already spent (review 20, H1). */
  spent: number;
};

const withDeadline = async <T>(p: Promise<T>, ms: number, fallback: () => T): Promise<T> => {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.catch(() => fallback()),
      new Promise<T>((ok) => {
        t = setTimeout(() => ok(fallback()), ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
};

const txidOf = (outpoint: string) => outpoint.slice(0, outpoint.lastIndexOf('.'));

export function createReceiveWatch(deps: ReceiveWatchDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const log = deps.log ?? (() => undefined);
  let leaseUntil = 0;
  let stopped = false;
  let timer: unknown = null;
  let ticking: Promise<WatchTick> | null = null;
  let failures = 0;
  let rateLimited = false;
  /** This run: transactions that are not plain coins of ours (names, tokens; or an address the intake has no key for). */
  const skip = new Set<string>();
  const memBackoff = new Map<string, number>();
  const backoff = deps.backoff ?? {
    due: (t: string) => (memBackoff.get(t) ?? 0) <= now(),
    fail: (t: string) => (memBackoff.set(t, now() + 30_000), 30_000),
    clear: (t: string) => void memBackoff.delete(t),
  };

  const inFront = () => !stopped && leaseUntil > now();

  /** Read the stream; after STREAM_TIMEOUT_MS the request is aborted and the look fails. */
  const collect = async (addresses: string[], from: number): Promise<WatchRow[]> => {
    const ctl = new AbortController();
    const rows: WatchRow[] = [];
    const iter = deps.stream(addresses, from, ctl.signal)[Symbol.asyncIterator]();
    let t: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((ok) => {
      t = setTimeout(() => ok('late'), deps.timeouts?.streamMs ?? STREAM_TIMEOUT_MS);
    });
    try {
      for (;;) {
        const next = await Promise.race([iter.next(), late]);
        if (next === 'late') {
          ctl.abort();
          void Promise.resolve(iter.return?.(undefined)).catch(() => undefined);
          throw new Error('the indexer did not answer in time');
        }
        if (next.done) return rows;
        rows.push(next.value);
      }
    } finally {
      if (t) clearTimeout(t);
    }
  };

  const look = async (): Promise<WatchTick> => {
    const r: WatchTick = { taken: 0, shown: 0, pulled: false, spent: 0 };
    if (!inFront()) return { ...r, skipped: 'background' };
    if (!deps.active()) return { ...r, skipped: 'inactive' };
    const addresses = [...new Set(deps.addresses().filter(Boolean))];
    if (!addresses.length) return { ...r, skipped: 'no-addresses' };
    const from = await withDeadline(deps.from(), deps.timeouts?.fromMs ?? FROM_DEADLINE_MS, () =>
      watchFrom(undefined, now()),
    );
    const rows = await collect(addresses, from);
    if (!inFront() || !deps.active()) return { ...r, skipped: 'inactive' };

    const byOutpoint = latestState(rows);
    const latest = [...byOutpoint.values()];
    const mined = new Set(
      rows.filter((x) => typeof x.score === 'number' && x.score < BLOCK_SCORE_MAX).map((x) => normOutpoint(x.outpoint)),
    );
    noteConfirmed(mined);
    // An unmined row always falls in the window (scored by time, above any height): a receipt no longer in it was mined
    // more than two blocks ago (say, while the app was in the background).
    noteConfirmed(unconfirmedOutpoints().filter((op) => !byOutpoint.has(op)));

    /** Spent outputs: never arriving; a spender this wallet does not hold means another copy took it: pull. */
    const settleSpent = async (outpoints: string[], spenders: string[]) => {
      dropArriving(outpoints);
      if (!spenders.length) return;
      const known = await deps.knownTxids(spenders);
      const foreign = spenders.filter((t) => !known.has(t));
      if (foreign.length && deps.askPull(foreign)) r.pulled = true;
    };
    const spent = latest.filter((o) => !!o.spendTxid);
    if (spent.length)
      await settleSpent(
        spent.map((o) => o.outpoint),
        [...new Set(spent.map((o) => o.spendTxid!))],
      );

    // New unspent outputs storage has no row for, by transaction.
    const unspent = latest.filter((o) => !o.spendTxid);
    if (!unspent.length) return r;
    const states = await deps.states(unspent.map((o) => o.outpoint));
    const byTxid = new Map<string, string[]>();
    for (const o of unspent) {
      if (states.get(o.outpoint) !== 'absent') continue;
      const txid = txidOf(o.outpoint);
      if (skip.has(txid) || !backoff.due(txid)) continue;
      byTxid.set(txid, [...(byTxid.get(txid) ?? []), o.outpoint]);
    }
    for (const txid of [...byTxid.keys()]) if (await deps.processed(txid)) byTxid.delete(txid); // the full sync's
    if (!byTxid.size) return r;

    // Payments first, without downloading names (M4).
    const classes = await deps.classify([...byTxid.keys()], byTxid);
    const coins: string[] = [];
    for (const [txid] of byTxid) {
      const c = classes.get(txid) ?? 'later';
      if (c === 'not-coin') skip.add(txid);
      else if (c === 'coin') coins.push(txid);
    }
    if (!coins.length) return r;

    // Spent already, mempool included (H1): never taken in, never shown. Can't tell: next look.
    const ops = coins.flatMap((t) => byTxid.get(t) ?? []);
    const answer = await deps.spends(ops).catch(() => new Map<string, string | null>());
    const named = spentIn(answer, ops);
    if (named.spent.length) {
      r.spent += named.spent.length;
      await settleSpent(named.spent, named.spenders);
    }
    const ready = coins
      .filter((t) => (byTxid.get(t) ?? []).every((o) => answer.get(o) === null))
      .slice(0, FETCHES_PER_LOOK);

    for (const txid of ready) {
      const wanted = new Set(byTxid.get(txid));
      try {
        const beef = await deps.fetchBeef(txid);
        const intake = await deps.intake();
        const outs: ChainOutput[] = intake
          .coins(txid, beef)
          .map((c) => ({ outpoint: `${txid}.${c.vout}`, satoshis: c.satoshis, address: '' }))
          .filter((c) => wanted.has(c.outpoint));
        if (!outs.length) {
          skip.add(txid); // pays an address the intake has no key for: the receive guard's (review 20, L11)
          continue;
        }
        // Shown at once, as pending, while it comes in (each balance read checks storage: counted once either way).
        addArriving(outs);
        if (!outs.some((o) => mined.has(o.outpoint))) noteUnconfirmed(outs, now());
        r.shown += outs.length;
        deps.changed(0);
        // A site may have started a multi-step action meanwhile: never internalize between its steps (L5).
        if (!deps.active()) break;
        const res = await intake.take(txid, beef);
        // Storage holds it now, or it is spent: either way it no longer counts as arriving (L1).
        dropArriving(outs.map((o) => o.outpoint));
        backoff.clear(txid);
        if (res === 'taken') r.taken++;
        if (res === 'none') skip.add(txid);
        if (res === 'spent' || res === 'unclear' || res === 'none') noteConfirmed(outs.map((o) => o.outpoint));
        if (res === 'spent') r.spent += outs.length;
      } catch (e) {
        const wait = backoff.fail(txid, e);
        log(
          `[receiveWatch] ${txid} not taken in (next try in ${Math.round(wait / 1000)} s):`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
    if (r.taken || r.spent) deps.changed(r.taken);
    return r;
  };

  /** One look at a time; a call while one runs joins it. */
  const tick = (): Promise<WatchTick> => {
    if (!ticking)
      ticking = look()
        .then((r) => {
          failures = 0;
          rateLimited = false;
          return r;
        })
        .catch((e: unknown): WatchTick => {
          failures++;
          rateLimited = isRateLimited(e);
          log(
            `[receiveWatch] look failed (next in ${Math.round(lookDelay(failures, rateLimited) / 1000)} s):`,
            e instanceof Error ? e.message : String(e),
          );
          return { taken: 0, shown: 0, pulled: false, spent: 0, skipped: 'failed' };
        })
        .finally(() => (ticking = null));
    return ticking;
  };

  const schedule = (ms: number) => {
    if (timer !== null || !inFront()) return;
    timer = setTimer(() => {
      timer = null;
      if (!inFront()) return;
      void tick().then(() => schedule(lookDelay(failures, rateLimited)));
    }, ms);
  };

  return {
    /** APP_FOREGROUND (true) renews the lease and starts looking; APP_BACKGROUND (false) stops. */
    foreground(on: boolean) {
      if (stopped) return;
      if (!on) {
        leaseUntil = 0;
        if (timer !== null) clearTimer(timer);
        timer = null;
        return;
      }
      leaseUntil = now() + FOREGROUND_LEASE_MS;
      schedule(0);
    },
    tick,
    /** The wallet closed: never runs again. */
    stop() {
      stopped = true;
      leaseUntil = 0;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    state: () => ({
      inFront: inFront(),
      scheduled: timer !== null,
      failures,
      nextDelay: lookDelay(failures, rateLimited),
    }),
  };
}

export type ReceiveWatch = ReturnType<typeof createReceiveWatch>;
