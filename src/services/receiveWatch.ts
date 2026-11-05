/**
 * Instant receive (owner, 5 Nov 2026: the iPhone showed neither of two $1 payments after 20+ minutes in front; the
 * extension took them in only on its 60 s address-sync alarm, behind a 45 s gate, re-reading all history each time).
 *
 * While the app or extension UI is in front (APP_FOREGROUND, renewed every 30 s; APP_BACKGROUND stops it), every ~3 s
 * this asks the 1Sat indexer (the same owner-sync stream the address sync reads) about the wallet's receive addresses
 * only, from two blocks below the tip: everything mined in the last ~20 minutes and everything not mined yet.
 *  - A new unspent output storage has no row for: taken in through the address sync's own coin intake
 *    (prioritySyncRun.ts makeCoinIntake: shared internalize lock, recorded in the processed-tx store so the full sync
 *    skips it). It shows at once as pending (receiveGuard.ts addArriving / noteUnconfirmed); every balance read checks
 *    it against storage, so it counts once before and after it lands. Nothing is swept here: the address sync and the
 *    funding preparation sweep as before, so two copies of this wallet never race to sweep a coin within seconds.
 *  - One of our receive outputs spent by a transaction this wallet does not hold: another copy of this wallet (the
 *    owner's other device, same seed) took it. The device-sync pull runs at once (throttled), so its change arrives
 *    through the backup, under the inbound guard, without a reopen.
 *  - A receipt seen mined is no longer pending; an output spent on chain is no longer "arriving".
 * Only while this device's store is active: the remote store is never written from here, and every row from another
 * device still goes through the inbound sync guard and this device's admission list.
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
/** A transaction that failed to come in is tried again after this. */
export const RETRY_AFTER_MS = 30_000;
/** One look at the indexer gives up after this; the next tick asks again. */
export const STREAM_TIMEOUT_MS = 10_000;

/** The `from` score to ask with: two blocks below the tip, or (tip unknown) unmined events of the last 15 minutes. */
export const watchFrom = (height: number | undefined, nowMs: number): number =>
  height && height > WATCH_BLOCKS_BACK ? height - WATCH_BLOCKS_BACK : Math.floor(nowMs / 1000) - 15 * 60;

export type WatchRow = { outpoint: string; score?: number; spendTxid?: string };

export type ReceiveWatchDeps = {
  /** This device's store is active, the wallet open, no site mid-action: otherwise the watcher does nothing. */
  active: () => boolean;
  /** The receive addresses (the Receive screen's address and the deposit addresses handed out). */
  addresses: () => string[];
  /** The `from` score for the indexer (watchFrom). */
  from: () => Promise<number>;
  /** services.owner.sync(addresses, from). */
  stream: (addresses: string[], from: number) => AsyncIterable<WatchRow>;
  /** What storage holds for each outpoint (services/heldOutpoints.ts). */
  states: (outpoints: string[]) => Promise<Map<string, OutpointState>>;
  /** Of these txids, the ones storage holds a transaction for. */
  knownTxids: (txids: string[]) => Promise<Set<string>>;
  /** The processed-tx store already has this txid (the full sync took it in). */
  processed: (txid: string) => Promise<boolean>;
  fetchBeef: (txid: string) => Promise<number[]>;
  /** The address sync's coin intake (prioritySyncRun.ts makeCoinIntake); made on first use (it derives the keys). */
  intake: () => Promise<Pick<CoinIntake, 'coins' | 'take'>>;
  /** The device-sync pull (deviceSync.syncNow). */
  pull: () => Promise<unknown>;
  /** The balance changed (shown pending, or taken in): the UI reads it now. */
  changed: (found: number) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  log?: (...a: unknown[]) => void;
};

export type WatchTick = {
  /** Why nothing was asked, when nothing was. */
  skipped?: 'background' | 'inactive' | 'busy' | 'no-addresses';
  /** Transactions taken in by this tick. */
  taken: number;
  /** Outputs shown as pending by this tick. */
  shown: number;
  /** A device-sync pull was asked for. */
  pulled: boolean;
};

export function createReceiveWatch(deps: ReceiveWatchDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const log = deps.log ?? (() => undefined);
  let leaseUntil = 0;
  let stopped = false;
  let timer: unknown = null;
  let ticking: Promise<WatchTick> | null = null;
  let lastPullAt = -Infinity;
  /** Pulls asked per unknown spender txid. */
  const pullTries = new Map<string, number>();
  /** Transactions paying us no plain coin (names, tokens): the full sync's; never fetched again here. */
  const noCoin = new Set<string>();
  /** Transactions that failed to come in, and when to try again. */
  const retryAt = new Map<string, number>();

  const inFront = () => !stopped && leaseUntil > now();

  /** Read the stream, giving up after STREAM_TIMEOUT_MS (a hung request never wedges the watcher). */
  const collect = async (it: AsyncIterable<WatchRow>): Promise<WatchRow[]> => {
    const rows: WatchRow[] = [];
    const iter = it[Symbol.asyncIterator]();
    let t: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((ok) => {
      t = setTimeout(() => ok('late'), STREAM_TIMEOUT_MS);
    });
    try {
      for (;;) {
        const next = await Promise.race([iter.next(), late]);
        if (next === 'late') {
          void iter.return?.(undefined)?.catch?.(() => undefined);
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
    const r: WatchTick = { taken: 0, shown: 0, pulled: false };
    if (!inFront()) return { ...r, skipped: 'background' };
    if (!deps.active()) return { ...r, skipped: 'inactive' };
    const addresses = [...new Set(deps.addresses().filter(Boolean))];
    if (!addresses.length) return { ...r, skipped: 'no-addresses' };
    const rows = await collect(deps.stream(addresses, await deps.from()));
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

    // Spent on chain: never arriving. Spent by a transaction this wallet doesn't hold: another copy took it, pull now.
    const spent = latest.filter((o) => !!o.spendTxid);
    if (spent.length) {
      dropArriving(spent.map((o) => o.outpoint));
      const spenders = [...new Set(spent.map((o) => o.spendTxid!))];
      const known = await deps.knownTxids(spenders);
      const foreign = spenders.filter((t) => !known.has(t) && (pullTries.get(t) ?? 0) < PULL_TRIES);
      if (foreign.length && now() - lastPullAt >= PULL_THROTTLE_MS) {
        for (const t of foreign) pullTries.set(t, (pullTries.get(t) ?? 0) + 1);
        lastPullAt = now();
        r.pulled = true;
        log(`[receiveWatch] ${foreign.length} receive output(s) spent elsewhere (${foreign[0]}…): pulling the backup`);
        void deps.pull().catch((e: unknown) => log('[receiveWatch] pull failed:', e));
      }
    }

    // New unspent outputs storage has no row for, by transaction.
    const unspent = latest.filter((o) => !o.spendTxid);
    if (!unspent.length) return r;
    const states = await deps.states(unspent.map((o) => o.outpoint));
    const byTxid = new Map<string, Set<string>>();
    for (const o of unspent) {
      if (states.get(o.outpoint) !== 'absent') continue;
      const txid = o.outpoint.slice(0, o.outpoint.lastIndexOf('.'));
      if (noCoin.has(txid) || (retryAt.get(txid) ?? 0) > now()) continue;
      byTxid.set(txid, (byTxid.get(txid) ?? new Set()).add(o.outpoint));
    }
    for (const [txid, ops] of byTxid) {
      try {
        if (await deps.processed(txid)) continue; // the full sync took it in; anything storage lacks is the guard's
        const beef = await deps.fetchBeef(txid);
        const intake = await deps.intake();
        const outs: ChainOutput[] = intake
          .coins(txid, beef)
          .map((c) => ({ outpoint: `${txid}.${c.vout}`, satoshis: c.satoshis, address: '' }))
          .filter((c) => ops.has(c.outpoint));
        if (!outs.length) {
          noCoin.add(txid);
          continue;
        }
        // Shown at once, as pending, while it comes in (each balance read checks storage: counted once either way).
        addArriving(outs);
        if (!outs.some((o) => mined.has(o.outpoint))) noteUnconfirmed(outs, now());
        r.shown += outs.length;
        deps.changed(0);
        const res = await intake.take(txid, beef);
        retryAt.delete(txid);
        if (res === 'taken') r.taken++;
        if (res === 'none') noCoin.add(txid);
      } catch (e) {
        retryAt.set(txid, now() + RETRY_AFTER_MS);
        log(`[receiveWatch] ${txid} not taken in yet:`, e instanceof Error ? e.message : String(e));
      }
    }
    if (r.taken) deps.changed(r.taken);
    return r;
  };

  /** One look at a time; a call while one runs joins it. */
  const tick = (): Promise<WatchTick> => {
    if (!ticking)
      ticking = look()
        .catch((e: unknown): WatchTick => {
          log('[receiveWatch] look failed:', e instanceof Error ? e.message : String(e));
          return { taken: 0, shown: 0, pulled: false, skipped: 'busy' };
        })
        .finally(() => (ticking = null));
    return ticking;
  };

  const schedule = (ms: number) => {
    if (timer !== null || !inFront()) return;
    timer = setTimer(() => {
      timer = null;
      if (!inFront()) return;
      void tick().then(() => schedule(WATCH_INTERVAL_MS));
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
    state: () => ({ inFront: inFront(), scheduled: timer !== null, lastPullAt }),
  };
}

export type ReceiveWatch = ReturnType<typeof createReceiveWatch>;
