/**
 * A payment's change reaches the backup BEFORE the payment is broadcast (balance integrity plan, fix 4, 13 Nov 2026).
 *
 * Why: a BRC-29 change output can only be spent with the derivationPrefix/Suffix stored on its output row, written by
 * createAction on the device that made the payment. Until the device sync pushes that row (~20 s after the payment,
 * longer on a back-off), the change exists on that one device. If the device is wiped in that window (the extension's
 * Remove + reload deletes its database, which has happened to the owner) or its push never lands, the coins are on chain
 * and nobody can spend them. Store payments already pushed before sending (deviceSync backupBeforeSend, 60 s, fail
 * closed); every other send did not.
 *
 * Where: every broadcast the wallet-toolbox makes goes through `services.postBeef` (attemptToPostReqsToNetwork), and the
 * rows are committed before it: createAction / signAction (storage processAction: commitNewTxToStorage, then
 * shareReqsWithWorld), a later sendWith of noSend payments, the Monitor's SendWaiting (acceptDelayedBroadcast: big
 * transactions). Each of those callers holds the storage manager's writer lock (processAction / commitActionBatch:
 * runAsWriter; the Monitor: runAsStorageProvider) while it posts. So:
 *  - `watchStorage` marks ("arms") the txids a processAction / commitActionBatch is about to send, for as long as the
 *    call runs (a delayed send stays armed until the Monitor posts it). internalizeAction is not armed (review, 13 Nov
 *    2026, LOW): the toolbox writes a received payment's outputs in a second transaction AFTER its broadcast, so a push
 *    before it carries none of them; the device sync's push takes them later, as before.
 *  - `onBroadcast` wraps services.postBeef: a post naming an armed txid first pushes this device's changes to the backup
 *    (`beforeBroadcast`), then posts. A post naming none (a rebroadcast of an old transaction by a heal) is untouched.
 *  - The push is the device sync's own push cycle (syncToWriter through pushView, per-request deadlines, no request to a
 *    backup still answering a timed-out one), run with the caller's lock (`activeSync`): taking the manager's sync lock
 *    here would wait for the writer lock the caller holds, for ever. With that lock held nothing else writes to this
 *    device's store, so the cycle runs whole, as pushView requires. The caller is known to hold it when the post names a
 *    txid armed by a running processAction / commitActionBatch (both run inside runAsWriter), or a delayed send while a
 *    storage-provider lock is held (the Monitor). No writer lock held at all: the cycle takes the locks itself. A writer
 *    lock held by someone the caller can't be shown to be (review, LOW): no push at all (running inside another call's
 *    lock would let it write mid-cycle; waiting for it could be waiting on ourselves): flagged, the urgent retry pushes.
 *  - A deadline, WRITE_AHEAD_MS (8 s), up to and including the cycle's first data page (each request gets what is left
 *    of it; none starts after it). Once a page is committed the cycle finishes under the device sync's ordinary
 *    per-request limits (review, MEDIUM): a cycle cut after a committed page leaves the backup's checkpoint mid-cycle,
 *    the "push cycle is never paused" hazard (pushView.ts): a coin updated before the next cycle sorts before the saved
 *    position, is never sent, and the backup keeps it spendable. So a payment waits at most ~8 s for a backup that is
 *    slow from the start, longer only while a big backlog (more than one page, 64 rows) drains to an answering backup.
 *  - A backup still answering an earlier timed-out request: no wait at all (review, MEDIUM-LOW: the wait held the writer
 *    lock, which blocks reads too, so every payment took 8 s more and screens froze, for up to IN_FLIGHT_MAX_AGE_MS).
 *    After a failed push the write-ahead is skipped for COOL_OFF_MS (each payment flagged at once) until a push goes
 *    through again.
 *
 * POLICY (flag for the owner): the backup being down never stops a payment. If the push fails or runs out of time, the
 * payment is still broadcast, its txids are recorded as "change not backed up yet" (count shown on the balance card and
 * in syncHealth.changeNotBackedUp; persisted per account so a restart still shows it), and the push is retried urgently
 * after the broadcast (5 s, 15 s, 30 s, 1 min, 2 min, then every 5 min) through the device sync's pushNow, until a push
 * that started after the payment went through. Store payments keep their own fail-closed backup-before-send (not sent
 * while the backup is down), unchanged. Not covered: no backup configured (nothing to push to, as before); the remote
 * store active (the rows were written there); broadcasts outside the toolbox (pots' and presigned payments' raw
 * broadcasts, sweeps of foreign keys): their rows were written when they were signed, earlier, and pushed by the device
 * sync since.
 *
 * Cost: every payment waits for one push cycle to the backup before it goes out (usually 2–3 requests, under a second on
 * a good line; at most WRITE_AHEAD_MS). The device sync's debounced push 20 s later still runs: it carries what the
 * broadcast wrote after this push (request and transaction status), usually one small page.
 *
 * The backup's copy of the payment (asSending): transaction 'sending', proof request 'nosend'. The toolbox never changes
 * a proof request's status in a store once it is there (EntityProvenTxReq.mergeExisting), so whatever this push writes
 * is what the backup and every copy restored or pulled from it keep (the transaction row does follow later pushes:
 * unproven, completed, failed). It was 'unsent' (review, 13 Nov 2026, MEDIUM-HIGH, shown in the two-device sim): every
 * copy's Monitor (SendWaiting) broadcast it, so a payment this device had given up on (refused for a while, inputs
 * freed, perhaps paid again) could go out from another device. 'nosend' = "not this store's to send": no copy ever
 * sends it; the toolbox's 'nosend' proof task (CheckNoSends) collects its proof once mined, and gives up after its
 * attempt limit ('invalid': failed, inputs freed) for one that never was; the stuck-send release (stuckSends.ts) covers
 * a copy's 'sending' payment the network never had. 'unknown' (also never sent) was not used: the toolbox reads a
 * payment's bytes from its request only in a known set of states (getRawTxForSlice / getProvenOrRawTx: 'unsent',
 * 'sending', 'nosend', 'unmined', 'completed'…, never 'unknown'), so no copy could read its change's scripts or build a
 * spend of it until mined; the sim shows the restored device refusing all its change.
 */
import type { DeviceSyncResult } from './deviceSync';
import { pushView, type InFlight } from './pushView';

/** The longest a payment waits for its rows to reach the backup before it is broadcast anyway (and flagged). */
export const WRITE_AHEAD_MS = 8_000;
/** A delayed send not posted within this long was aborted or failed: no longer armed. */
export const DELAYED_ARM_MS = 24 * 3_600_000;
/** After a failed write-ahead push: retry the push after these waits (the last repeats) until it goes through. */
export const URGENT_RETRY_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
/** After a failed write-ahead push, payments skip it (flagged at once) this long, or until a push goes through. */
export const COOL_OFF_MS = 60_000;

type Auth = unknown;

/** The storage manager (WalletStorageManager) as used here. */
export type WriteAheadStorage = {
  getAuth(mustBeActive?: boolean): Promise<Auth>;
  /** The active store, passed as `activeSync` so syncToWriter takes no lock. */
  getActive(): unknown;
  syncToWriter(auth: Auth, writer: object, activeSync?: unknown): Promise<unknown>;
  /** The manager's writer-lock queue (non-empty: a writer holds it, or one is waiting). */
  writerLocks?: unknown[];
  /** The manager's storage-provider-lock queue (non-empty: a runAsStorageProvider call, e.g. the Monitor, holds it). */
  spLocks?: unknown[];
};

export type UnbackedRecord = { txids: string[]; since: number };

export type WriteAheadDeps = {
  /** This device's store is active and a backup is configured (the only setup this applies to). */
  applies: () => boolean;
  /** The connected backups (empty: configured but not connected now). */
  backups: () => ReadonlyArray<{ storage: unknown }>;
  storage: WriteAheadStorage;
  /** The device sync's per-backup record of timed-out requests (initWallet pushInFlight): shared, never two at once. */
  inFlightFor: (backup: object) => InFlight;
  /** The device sync's pushNow (services/deviceSync.ts): the urgent retry after a payment went out unbacked. */
  pushNow: () => Promise<DeviceSyncResult>;
  budgetMs?: number;
  retryMs?: number[];
  coolOffMs?: number;
  /** Called with the number of payments whose change is not backed up yet, whenever it changes. */
  onChange?: (n: number) => void;
  /** Where the unbacked list is kept across restarts (chrome.storage.local per account); optional. */
  kv?: { load(): Promise<UnbackedRecord | null | undefined>; save(r: UnbackedRecord | null): Promise<void> };
  log?: (m: string) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  /** The urgent retry's timer (default: setTimer / clearTimer). */
  retryTimer?: { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void };
};

export type WriteAheadOutcome =
  /** None of the posted txids was armed: not a new payment of this wallet (a rebroadcast): nothing done. */
  | { how: 'not-ours' }
  /** The remote store is active or no backup is configured: nothing to push to. */
  | { how: 'no-backup' }
  /** This device's changes, the payment's rows among them, are in the backup. */
  | { how: 'pushed'; ms: number }
  /** The push failed or ran out of time: the payment goes out anyway, flagged and retried. */
  | { how: 'unbacked'; error: string };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const norm = (t: unknown) => (typeof t === 'string' ? t.toLowerCase() : '');

export function createChangeWriteAhead(d: WriteAheadDeps) {
  const now = d.now ?? Date.now;
  const setTimer = d.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = d.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const log = d.log ?? ((m: string) => console.warn(m));
  const retryTimers = d.retryTimer ?? { set: setTimer, clear: clearTimer };
  const budgetMs = d.budgetMs ?? WRITE_AHEAD_MS;
  const retryMs = d.retryMs?.length ? d.retryMs : URGENT_RETRY_MS;
  const coolOffMs = d.coolOffMs ?? COOL_OFF_MS;
  /** Until when payments skip the write-ahead after a failed one (0: not cooling off). */
  let coolUntil = 0;
  /** txid → how many running calls armed it. */
  const armed = new Map<string, number>();
  /** Delayed sends (the Monitor posts them later): txid → when armed; armed until posted (or DELAYED_ARM_MS old). */
  const delayed = new Map<string, number>();
  /** Payments that went out before their rows reached the backup: txid → when, and the mark sequence. */
  const unbacked = new Map<string, { at: number; seq: number }>();
  let seq = 0;
  let retryTimer: unknown = null;
  let retryAttempt = 0;

  const changed = () => {
    try {
      d.onChange?.(unbacked.size);
    } catch {
      /* display only */
    }
    if (!d.kv) return;
    const since = Math.min(...[...unbacked.values()].map((u) => u.at));
    void d.kv.save(unbacked.size ? { txids: [...unbacked.keys()], since } : null).catch(() => undefined);
  };

  const isArmed = (t: string) => armed.has(t) || delayed.has(t);

  const arm = (txids: Iterable<string>, o: { delayed?: boolean } = {}) => {
    const list = [...new Set([...txids].map(norm).filter(Boolean))];
    if (o.delayed) {
      const t0 = now();
      for (const [t, at] of delayed) if (t0 - at > DELAYED_ARM_MS) delayed.delete(t); // never posted: aborted or failed
      for (const t of list) delayed.set(t, t0);
      return () => undefined;
    }
    for (const t of list) armed.set(t, (armed.get(t) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      for (const t of list) {
        const n = (armed.get(t) ?? 1) - 1;
        if (n > 0) armed.set(t, n);
        else armed.delete(t);
      }
    };
  };

  /** Pushes that started at sequence `cap` went through: what was marked by then is in the backup. */
  const pushed = (cap: number) => {
    coolUntil = 0; // the backup answered: the next payment pushes first again
    let n = 0;
    for (const [t, u] of unbacked)
      if (u.seq <= cap) {
        unbacked.delete(t);
        n++;
      }
    if (!n) return;
    log(`[writeAhead] ${n} payment(s) whose change was not backed up are now in the backup`);
    if (!unbacked.size) {
      retryAttempt = 0;
      if (retryTimer) retryTimers.clear(retryTimer);
      retryTimer = null;
    }
    changed();
  };

  const scheduleRetry = () => {
    if (retryTimer || !unbacked.size) return;
    const wait = retryMs[Math.min(retryAttempt, retryMs.length - 1)];
    retryTimer = retryTimers.set(() => {
      retryTimer = null;
      void retryNow();
    }, wait);
  };

  /** One urgent retry (the timer's; tests call it directly). */
  const retryNow = async (): Promise<boolean> => {
    if (!unbacked.size) return true;
    if (!d.applies()) {
      // The remote store became active (its switch copies this store's rows to it first) or the backup was removed:
      // nothing left to push to.
      log(`[writeAhead] no device backup applies any more: ${unbacked.size} unbacked mark(s) dropped`);
      unbacked.clear();
      changed();
      return true;
    }
    retryAttempt++;
    const cap = seq;
    const r = await d.pushNow().catch((e: unknown) => ({ ok: false as const, error: errText(e) }));
    if (r.ok && r.pushed) pushed(cap);
    else log(`[writeAhead] urgent backup retry failed: ${r.ok ? 'not pushed' : r.error}`);
    scheduleRetry();
    return !unbacked.size;
  };

  const flag = (txids: string[], error: string, o: { coolOff?: boolean } = {}): WriteAheadOutcome => {
    if (o.coolOff !== false) coolUntil = now() + coolOffMs;
    const s = ++seq;
    for (const t of txids) unbacked.set(t, { at: now(), seq: s });
    log(
      `[writeAhead] backup before broadcast failed (${error}): sending anyway, change of ${txids.map((t) => t.slice(0, 8)).join(', ')} not backed up yet`,
    );
    changed();
    scheduleRetry();
    return { how: 'unbacked', error };
  };

  /**
   * Called by the postBeef wrapper before the broadcast. Never throws and never stops the broadcast. Returns once the
   * push cycle has ended (whole, or failed at a deadline), at most about `budgetMs` after it was called.
   */
  const beforeBroadcast = async (txids: readonly string[]): Promise<WriteAheadOutcome> => {
    const mine = [...new Set((txids ?? []).map(norm))].filter(isArmed);
    if (!mine.length) return { how: 'not-ours' };
    // Posted from inside a running processAction / commitActionBatch (runAsWriter), or a delayed send (the Monitor).
    const byRunningCall = mine.some((t) => armed.has(t));
    const byDelayed = mine.some((t) => delayed.has(t));
    for (const t of mine) delayed.delete(t);
    try {
      if (!d.applies()) return { how: 'no-backup' };
    } catch {
      return { how: 'no-backup' };
    }
    // Just failed: not waited for again (each payment flagged at once) until a push goes through or the cool-off ends.
    if (now() < coolUntil) return flag(mine, 'the backup failed moments ago: not waited for', { coolOff: false });
    const t0 = now();
    const deadlineAt = t0 + budgetMs;
    // Every push that starts from here on carries these rows; a mark made after this is the next payment's.
    const cap = ++seq;
    try {
      const list = d.backups();
      if (!list.length) throw new Error('the backup is not connected');
      const active = d.storage.getActive();
      const activeSync = lockToUse(d.storage, active, byRunningCall, byDelayed);
      const auth = await d.storage.getAuth(true);
      const rawTxOf = proofRequestRawTx(active);
      for (const b of list) {
        const backup = b.storage as object;
        const inFlight = d.inFlightFor(backup);
        // Never waited for while the caller holds the writer lock (it blocks reads too): fail at once.
        if (!(await inFlight.settled(0))) throw new Error('network: the backup is still answering an earlier request');
        const view = pushView(backup, { inFlight, deadlineAt, now, setTimer, clearTimer });
        await d.storage.syncToWriter(auth, asSendingView(view, new Set(mine), rawTxOf), activeSync);
      }
      pushed(cap);
      return { how: 'pushed', ms: now() - t0 };
    } catch (e) {
      // A busy lock says nothing about the backup: no cool-off for it.
      return flag(mine, errText(e), { coolOff: !(e instanceof LockBusy) });
    }
  };

  /** The unbacked list from before a restart (wallet open): the open-time sync's push clears it. */
  const hydrate = async () => {
    const r = await d.kv?.load().catch(() => null);
    if (!r || !Array.isArray(r.txids) || !r.txids.length) return;
    for (const t of r.txids.map(norm).filter(Boolean))
      if (!unbacked.has(t)) unbacked.set(t, { at: typeof r.since === 'number' ? r.since : now(), seq: 0 });
    changed();
    scheduleRetry();
  };

  return {
    arm,
    beforeBroadcast,
    /** The sequence a push starting now records; pass it to `pushed` when that push has gone through. */
    checkpoint: () => seq,
    pushed,
    retryNow,
    hydrate,
    /** Payments whose change is not in the backup yet. */
    count: () => unbacked.size,
    unbacked: () => [...unbacked.entries()].map(([txid, u]) => ({ txid, at: u.at })),
    stop: () => {
      if (retryTimer) retryTimers.clear(retryTimer);
      retryTimer = null;
    },
  };
}

export type ChangeWriteAhead = ReturnType<typeof createChangeWriteAhead>;

/**
 * The `activeSync` the write-ahead's cycle runs with: the active store when the caller posting is known to hold the
 * writer lock (syncToWriter then takes no lock: taking it would wait on the caller for ever), undefined when no writer
 * lock is held (the cycle takes the locks itself). A writer lock held by a call the caller can't be shown to be throws
 * (no push): running inside another call's lock would let it write mid-cycle, and waiting for it could deadlock.
 */
function lockToUse(storage: WriteAheadStorage, active: unknown, byRunningCall: boolean, byDelayed: boolean) {
  const writers = storage.writerLocks;
  if (!Array.isArray(writers)) throw new Error('storage locks not readable');
  if (writers.length === 0) return undefined;
  if (byRunningCall) return active; // processAction / commitActionBatch post inside their own runAsWriter
  const sp = storage.spLocks;
  if (byDelayed && Array.isArray(sp) && sp.length > 0) return active; // the Monitor: runAsStorageProvider
  throw new LockBusy('the storage lock is held by another call');
}
class LockBusy extends Error {}

// ── what the backup is told about a payment that is about to go out ──

type Row = Record<string, unknown>;
type Chunk = { transactions?: Row[]; provenTxReqs?: Row[]; [k: string]: unknown };

/** Reads the raw bytes of a payment from this device's proof request (where the toolbox keeps them until mined). */
function proofRequestRawTx(store: unknown): (txid: string) => Promise<unknown> {
  const s = store as { findProvenTxReqs?: (a: { partial: { txid: string } }) => Promise<Row[]> } | null;
  return async (txid) => {
    if (!s || typeof s.findProvenTxReqs !== 'function') return undefined;
    const [q] = await s.findProvenTxReqs({ partial: { txid } }).catch(() => [] as Row[]);
    return q?.rawTx;
  };
}

/**
 * The page as the backup should keep a payment that is about to be broadcast (a copy; this device's rows are untouched).
 * At this point the toolbox holds it as 'unprocessed' (proof request 'unprocessed'), the state of a payment that never
 * went anywhere: the wallet-open TaskFailAbandoned on any copy that holds it fails it after 5 minutes and frees its
 * inputs (services/pushParents.ts never sends a parent in that state for the same reason), and a backup holding it so
 * would keep it that way if this device never pushes again. The transaction goes as 'sending' ("handed to the sender":
 * copies track it, the abandoned sweep leaves it, the stuck-send release still applies to one that never lands); its
 * proof request as 'nosend', which no copy's Monitor ever sends and which keeps its bytes readable on every copy (see
 * the file header for why not 'unsent' or 'unknown'). Its raw bytes go on the transaction row too (from this device's
 * proof request), so the other copies' intake can check its outputs (services/inboundSync.ts scriptOf; the bytes must
 * hash to the txid). This device's next push carries the transaction's real outcome (unproven, failed…); the request's
 * status stays as written here (the toolbox never merges it).
 */
export async function asSending(
  chunk: Chunk,
  txids: ReadonlySet<string>,
  rawTxOf: (txid: string) => Promise<unknown>,
): Promise<Chunk> {
  if (!chunk || typeof chunk !== 'object') return chunk;
  const ours = (r: Row | undefined) => !!r && typeof r.txid === 'string' && txids.has(r.txid.toLowerCase());
  const anyTx = chunk.transactions?.some(ours);
  const anyReq = chunk.provenTxReqs?.some(ours);
  if (!anyTx && !anyReq) return chunk;
  const out: Chunk = { ...chunk };
  if (anyTx)
    out.transactions = await Promise.all(
      chunk.transactions!.map(async (t) => {
        if (!ours(t)) return t;
        const c: Row = { ...t };
        if (c.status === 'unprocessed') c.status = 'sending';
        const raw = c.rawTx as ArrayLike<number> | undefined;
        if (!raw || !raw.length) {
          const fromReq = (await rawTxOf(String(t.txid)).catch(() => undefined)) as ArrayLike<number> | undefined;
          if (fromReq && fromReq.length) c.rawTx = Array.from(fromReq);
        }
        return c;
      }),
    );
  if (anyReq)
    out.provenTxReqs = chunk.provenTxReqs!.map((q) => (ours(q) && q.status === 'unprocessed' ? { ...q, status: 'nosend' } : q));
  return out;
}

/** The backup (through pushView) with each page it is sent passed through asSending first. */
function asSendingView<T extends object>(
  view: T,
  txids: ReadonlySet<string>,
  rawTxOf: (txid: string) => Promise<unknown>,
): T {
  return new Proxy(view, {
    get(target, p) {
      const v = Reflect.get(target, p, target) as unknown;
      if (p !== 'processSyncChunk' || typeof v !== 'function') return v;
      const fn = v as (args: unknown, chunk: Chunk) => Promise<unknown>;
      return async (args: unknown, chunk: Chunk) => fn(args, await asSending(chunk, txids, rawTxOf));
    },
  });
}

// ── the wiring: which calls send what, and the broadcaster ──

type ProcessArgs = {
  isNewTx?: boolean;
  isNoSend?: boolean;
  isSendWith?: boolean;
  isDelayed?: boolean;
  txid?: string;
  sendWith?: string[];
};

/** The txids a storage processAction will post (the toolbox's own rule, processActionCore). */
export function processActionSends(args: ProcessArgs | undefined): string[] {
  if (!args || typeof args !== 'object') return [];
  const out = Array.isArray(args.sendWith) ? args.sendWith.filter((t) => typeof t === 'string') : [];
  const noSend = args.isNoSend === true && !(args.isSendWith === true || out.length > 0);
  if (args.isNewTx === true && typeof args.txid === 'string' && !noSend) out.push(args.txid);
  return out;
}

const WATCHED = Symbol.for('bwx.changeWriteAhead');
type Watchable = Record<string, unknown> & { [WATCHED]?: { current?: ChangeWriteAhead } };

/**
 * Arm what the storage manager's sending calls will post, for as long as each runs: processAction (createAction,
 * signAction, sendWith), commitActionBatch (non-legacy batches). Not internalizeAction (see the file header).
 * Re-installing points the same wrappers at the new write-ahead. Returns false when there is nothing to wrap.
 */
export function watchStorage(manager: unknown, wa: ChangeWriteAhead): boolean {
  const m = manager as Watchable | null;
  if (!m || typeof m.processAction !== 'function') return false;
  const slot = m[WATCHED];
  if (slot) {
    slot.current = wa;
    return true;
  }
  const holder: { current?: ChangeWriteAhead } = { current: wa };
  m[WATCHED] = holder;
  const wrap = (name: string, sends: (args: unknown) => { txids: string[]; delayed: boolean }) => {
    const fn = m[name];
    if (typeof fn !== 'function') return;
    const call = (fn as (...a: unknown[]) => Promise<unknown>).bind(m);
    m[name] = async (...a: unknown[]) => {
      let disarm = () => undefined as void;
      try {
        const s = sends(a[0]);
        if (s.txids.length) disarm = holder.current?.arm(s.txids, { delayed: s.delayed }) ?? disarm;
      } catch {
        /* never in a payment's way */
      }
      try {
        return await call(...a);
      } finally {
        disarm();
      }
    };
  };
  wrap('processAction', (args) => ({
    txids: processActionSends(args as ProcessArgs),
    delayed: (args as ProcessArgs | undefined)?.isDelayed === true,
  }));
  wrap('commitActionBatch', (manifest) => {
    const mf = manifest as { sendWith?: unknown; isDelayed?: unknown } | undefined;
    const txids = Array.isArray(mf?.sendWith) ? (mf.sendWith as unknown[]).filter((t) => typeof t === 'string') : [];
    return { txids: txids as string[], delayed: mf?.isDelayed === true };
  });
  return true;
}

type PostBeef = (beef: unknown, txids: string[], logger?: unknown) => Promise<unknown>;
type Broadcaster = { postBeef?: PostBeef; [WATCHED]?: { current?: ChangeWriteAhead } };

/**
 * Wrap services.postBeef: a post naming a payment armed by watchStorage pushes to the backup first (bounded), then posts
 * whatever the push did. Install it after the other postBeef wrappers so the backup wait is not timed as broadcast.
 * Re-installing points the wrapper at the new write-ahead. Returns false when there is no postBeef.
 */
export function onBroadcast(services: unknown, wa: ChangeWriteAhead): boolean {
  const s = services as Broadcaster | null;
  if (!s || typeof s.postBeef !== 'function') return false;
  const slot = s[WATCHED];
  if (slot) {
    slot.current = wa;
    return true;
  }
  const holder: { current?: ChangeWriteAhead } = { current: wa };
  s[WATCHED] = holder;
  const original = s.postBeef.bind(s);
  s.postBeef = async (beef, txids, logger) => {
    try {
      await holder.current?.beforeBroadcast(Array.isArray(txids) ? txids : []);
    } catch {
      /* never stops a payment */
    }
    return original(beef, txids, logger);
  };
  return true;
}
