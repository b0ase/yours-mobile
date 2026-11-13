/**
 * The device-sync PUSH (initWallet's deviceSync push; owner's seal, 7 Nov 2026: the open-time push had no deadline and
 * held the storage queue the seal's payment waited in).
 *
 * ⚠ A PUSH CYCLE IS NEVER PAUSED (review of perf/phone-seal-speed, 7 Nov 2026, HIGH). The toolbox resumes a push from
 * the backup's checkpoint: a `since` plus a per-entity offset over this device's rows filtered by updated_at. A payment
 * that writes during a paused cycle (spending old coin X moves X.updated_at into the filtered set, in front of the
 * offset) makes the resumed scan skip a row, and the cycle's `when` then passes X's update, so the backup keeps X
 * spendable for good. A cycle holds the storage queue from start to end, so nothing writes during it; own payments go
 * first only BEFORE a cycle starts (deviceSync waits for them) or BETWEEN backups (makeBackupPush).
 *
 * The view (pushView) puts a deadline on each backup request syncToWriter makes (makeAvailable, getSyncCheckpoint,
 * findOrInsertUser, findOrInsertSyncStateAuth, processSyncChunk): a backup that stops answering fails the push, which
 * frees the storage queue; the device sync retries on its back-off, from the backup's own durable checkpoint (a page the
 * backup committed after the client gave up is not sent again; one it didn't commit is). The toolbox's StorageClient
 * takes no AbortSignal (rpcCall → authenticatedFetch), so a timed-out request can't be cancelled: it is kept "in flight"
 * for its backup, and no push starts another request to that backup until it settles (makeBackupPush waits up to
 * SETTLE_WAIT_MS, then fails and backs off), so the backup never sees two pages at once.
 */

/**
 * Per request. Generous for a slow uplink: a push page is at most ~10 MB (the toolbox's maxRoughSize), and the
 * broadcaster's own sizing (bigBroadcast.ts) allows ~16 s per MB on top of 30 s; most pages are a few kB.
 */
export const PUSH_CALL_MS = 60_000;
/**
 * The small requests (makeAvailable, getSyncCheckpoint, findOrInsertUser, findOrInsertSyncStateAuth): a stalled
 * backup can't hold a payment for a minute on one of these (re-review, 7 Nov 2026).
 */
export const PUSH_SMALL_CALL_MS = 20_000;
/**
 * A timed-out request still counted as running on the backup's side at most this long (re-review, 7 Nov 2026, MED: a
 * callback-based fetch on WKWebView may never settle, which blocked every later push, and so every Store payment's
 * backup-before-send, until the app restarted). bit-sign's longest function runs 60 s; the backup service's own
 * request limit is well under this.
 */
export const IN_FLIGHT_MAX_AGE_MS = 5 * 60_000;
/** How long a push waits for its backup's earlier, timed-out request to settle before it fails (and backs off). */
export const SETTLE_WAIT_MS = 30_000;
const PUSH_CALLS = new Set([
  'makeAvailable',
  'getSyncCheckpoint',
  'findOrInsertUser',
  'findOrInsertSyncStateAuth',
  'processSyncChunk',
]);

type Timers = {
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  now?: () => number;
};
const timersOf = (t: Timers) => ({
  setTimer: t.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms)),
  clearTimer: t.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)),
});

/** Requests to one backup that timed out on our side and may still be running on the backup's. */
export interface InFlight {
  add(call: Promise<unknown>): void;
  /** True once every such request has settled (at once if none); false if any is still running after `waitMs`. */
  settled(waitMs: number): Promise<boolean>;
}

export function createInFlight(t: Timers & { maxAgeMs?: number } = {}): InFlight {
  const { setTimer, clearTimer } = timersOf(t);
  const now = t.now ?? Date.now;
  const maxAgeMs = t.maxAgeMs ?? IN_FLIGHT_MAX_AGE_MS;
  /** Each request that timed out on our side → when it did. Settled ones leave; ones older than maxAgeMs expire. */
  const pending = new Map<Promise<unknown>, number>();
  const prune = () => {
    for (const [p, at] of pending) if (now() - at >= maxAgeMs) pending.delete(p);
  };
  return {
    add(call) {
      const p = call.then(
        () => undefined,
        () => undefined,
      );
      pending.set(p, now());
      void p.then(() => pending.delete(p));
    },
    async settled(waitMs) {
      prune();
      if (!pending.size) return true;
      // Wait for them to settle, or to expire, whichever comes first, at most waitMs.
      const untilExpiry = Math.max(0, ...[...pending.values()].map((at) => at + maxAgeMs - now()));
      let timer: unknown;
      await Promise.race([
        Promise.all([...pending.keys()]),
        new Promise<void>((r) => {
          timer = setTimer(r, Math.min(waitMs, untilExpiry));
        }),
      ]);
      clearTimer(timer);
      prune();
      return !pending.size;
    },
  };
}

/**
 * The write-ahead never STARTS the cycle's first data page with less than this left before its deadline: a page sent
 * is given the ordinary limit, so one started too late would only make the payment wait longer.
 */
export const FIRST_PAGE_MIN_MS = 2_000;

/**
 * The backup with a deadline on each push request; a request that timed out is recorded in `inFlight`.
 *
 * `deadlineAt` (ms, on `now`; services/changeWriteAhead.ts, the push before a broadcast) only bounds what runs BEFORE
 * any data reaches the backup: the small requests get what is left of it (one asked for after it fails at once, never
 * sent), and the cycle's first data page (processSyncChunk) is started only with at least `firstPageMinMs` left.
 * Once a page has been sent it, and the rest of the cycle, run under the ordinary per-request limits: any data page cut
 * by a deadline may still be committed by the backup afterwards (a timed-out request can't be cancelled), and every
 * cycle is a data page plus a closing page, so a cut page leaves the backup's checkpoint mid-cycle (the hazard above;
 * re-review of 18c93dd9: a first page that timed out and committed late left a later payment's spent coin spendable).
 */
export function pushView<T extends object>(
  writer: T,
  o: Timers & {
    inFlight: InFlight;
    callMs?: number;
    smallCallMs?: number;
    deadlineAt?: number;
    firstPageMinMs?: number;
  },
): T {
  const callMs = o.callMs ?? PUSH_CALL_MS;
  const smallCallMs = o.smallCallMs ?? PUSH_SMALL_CALL_MS;
  const { setTimer, clearTimer } = timersOf(o);
  const now = o.now ?? Date.now;
  const firstPageMinMs = o.firstPageMinMs ?? FIRST_PAGE_MIN_MS;
  /** A data page of this cycle has been sent: `deadlineAt` no longer applies. */
  let paged = false;
  return new Proxy(writer, {
    get(target, p) {
      const v = Reflect.get(target, p, target) as unknown;
      if (typeof v !== 'function') return v;
      const fn = v as (...a: unknown[]) => unknown;
      const name = String(p);
      if (!PUSH_CALLS.has(name)) return fn.bind(target);
      return (...a: unknown[]) => {
        const page = name === 'processSyncChunk';
        const perCall = page ? callMs : smallCallMs;
        let ms = perCall;
        if (o.deadlineAt !== undefined && !paged) {
          const left = o.deadlineAt - now();
          if (page ? left < firstPageMinMs : left <= 0)
            return Promise.reject(new Error(`network: the backup did not answer in time (${name})`));
          if (!page) ms = Math.min(perCall, left);
        }
        if (page) paged = true; // sent: this page and the rest of the cycle under the ordinary limits
        const call = Promise.resolve().then(() => fn.apply(target, a));
        call.catch(() => undefined);
        let timer: unknown;
        return Promise.race([
          call,
          new Promise((_, reject) => {
            timer = setTimer(
              () => {
                o.inFlight.add(call); // still running on the backup's side: no second request until it settles
                reject(new Error(`network: the backup did not answer in time (${name})`));
              },
              ms,
            );
          }),
        ]).finally(() => clearTimer(timer));
      };
    },
  });
}

type PushStorage<A> = {
  getAuth(mustBeActive?: boolean): Promise<A>;
  syncToWriter(auth: A, writer: object): Promise<unknown>;
};

/**
 * updateBackups, as the device sync runs it: getAuth(true), then each backup's full syncToWriter cycle through the view.
 * A waiting own payment goes first only BETWEEN backups ('yielded': the device sync pushes again once it has finished,
 * starting with backups already up to date, which costs one empty page each). Throws when a backup is still answering
 * an earlier request, or when a request times out: the device sync counts that as a failure and backs off.
 */
export function makeBackupPush<A>(
  d: Timers & {
    storage: PushStorage<A>;
    backups: () => ReadonlyArray<{ storage: unknown }>;
    waiting: () => boolean;
    inFlightFor: (backup: object) => InFlight;
    callMs?: number;
    settleMs?: number;
  },
): () => Promise<void | 'yielded'> {
  return async () => {
    const auth = await d.storage.getAuth(true);
    const list = d.backups();
    for (let i = 0; i < list.length; i++) {
      if (i > 0 && d.waiting()) return 'yielded';
      const backup = list[i].storage as object;
      const inFlight = d.inFlightFor(backup);
      if (!(await inFlight.settled(d.settleMs ?? SETTLE_WAIT_MS)))
        throw new Error('network: the backup is still answering an earlier request');
      await d.storage.syncToWriter(
        auth,
        pushView(backup, { inFlight, callMs: d.callMs, setTimer: d.setTimer, clearTimer: d.clearTimer }),
      );
    }
  };
}
