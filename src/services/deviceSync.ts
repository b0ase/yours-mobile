/**
 * Keep this device and the owner's other devices in step through the shared backup store.
 *
 * Owner, 2 Nov 2026: the Chrome extension dropped to $0.16 after the iPhone swept 0.698 BSV and three other coins into
 * fresh change outputs. Each device keeps its own wallet database and they only meet in the backup (wallet.1sat.app):
 * the phone pushed its changes there only from the boot Monitor run (at most every 5 minutes, never while the app
 * stayed open), and no device ever pulled the others' changes in by itself. "Sync Now" (push) and Troubleshooting ›
 * Repair Sync (a full reconcile) were the only ways, and the owner found neither name clear.
 *
 * Here, with this device's own store active and a backup connected:
 *   - after any change (a send, sign, receive, abort) the backup is updated ~20 s later (debounced);
 *   - when the wallet opens, and on "Sync with my other devices", the backup's changes are pulled in, then this
 *     device's are pushed;
 *   - a backup that didn't connect at open is reconnected first; failures back off (1, 2, 4 … 30 minutes).
 * A pull is the toolbox's incremental syncFromReader (only what changed since the last pull), the same call Restore from
 * backup uses; a push is updateBackups.
 */

import { syncErrorDetail } from './syncErrorDetail';

export type DeviceSyncResult = { ok: true; pulled: boolean; pushed: boolean } | { ok: false; error: string };

export type DeviceSyncDeps = {
  /** This device's store is active and a backup is configured (the only setup this applies to). */
  applies: () => boolean;
  /** Connect the configured backup if it isn't connected; resolves true when one is connected. */
  ensureBackup: () => Promise<boolean>;
  /**
   * Bring the backup's changes into this device's store. 'yielded': it ended after a merged page to let an own payment
   * go first (fullPass afterPage); the run pulls again from that checkpoint once the payment has finished.
   */
  pull: () => Promise<void | 'yielded'>;
  /**
   * Copy this device's changes to the backup. 'yielded': it stopped after a committed page to let an own payment go
   * first (services/pushView.ts); the run pushes again from the backup's checkpoint once the payment has finished.
   */
  push: () => Promise<void | 'yielded'>;
  /** Own payments go first (services/ownPayments.ts): a run starts, and a yielded push carries on, once `idle`. */
  yieldTo?: { idle: () => Promise<void> };
  /** A connected site is part-way through a multi-step action: don't take storage locks now. */
  busy?: () => boolean;
  log?: (...a: unknown[]) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  /** Tests: the clock a run is timed on (SLOW_SYNC_MS). */
  now?: () => number;
};

export const PUSH_DELAY_MS = 20_000;
/**
 * A run this long is logged with its pull and push times: it holds the storage locks a payment queues behind (owner's
 * seal, 7 Nov 2026: one createAction took ~25 s just after the app opened, when the open-time sync runs).
 */
export const SLOW_SYNC_MS = 2_000;
export const BACKOFF_MS = [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000];
/** A push that failed on a deadline (services/pushView.ts) is retried within this, whatever the failure count. */
export const TIMEOUT_BACKOFF_CAP_MS = 240_000;
/** The backup didn't answer in time, or is still answering an earlier request (services/pushView.ts, fullPass.ts). */
export const isBackupTimeout = (e: unknown): boolean =>
  /did not answer in time|still answering an earlier request/.test(errText(e));
/**
 * A push that waits for a transaction to move on (services/pushParents.ts: unsigned or unprocessed until it goes out,
 * or the wallet-open abandoned-task sweep fails it) is retried this soon, however many times it waited.
 */
export const WAIT_BACKOFF_MS = 60_000;
export const isPushWait = (e: unknown): boolean => /push waits for /.test(errText(e));

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createDeviceSync(deps: DeviceSyncDeps) {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const log = deps.log ?? (() => undefined);
  const now = deps.now ?? Date.now;
  let running: Promise<DeviceSyncResult> | null = null;
  let runningMode: 'full' | 'push' | null = null;
  /** A full sync asked for while a push runs: it starts when that push ends (review 20, L6). */
  let fullAfter: Promise<DeviceSyncResult> | null = null;
  let pushTimer: unknown = null;
  let failures = 0;
  let pendingPush = false;
  /** When a push last went through (ms), 0 before the first: "Up to date" needs one with nothing waiting. */
  let lastPushOkAt = 0;

  const retryLater = (capMs = Infinity) => {
    const wait = Math.min(capMs, BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)]);
    schedule(wait);
    return wait;
  };

  /** Not this device's turn to sync (checked at the start and again after every wait for an own payment). */
  const notNow = (): DeviceSyncResult | null => {
    if (!deps.applies()) return { ok: true, pulled: false, pushed: false };
    if (deps.busy?.()) {
      schedule(PUSH_DELAY_MS);
      return { ok: false, error: 'a site action is in progress; sync deferred' };
    }
    return null;
  };

  const run = async (mode: 'full' | 'push'): Promise<DeviceSyncResult> => {
    const idle = () => deps.yieldTo?.idle() ?? Promise.resolve();
    /** Own payments first (services/ownPayments.ts), then the account, lock and dApp-chain checks again. */
    const myTurn = async () => {
      await idle();
      return notNow();
    };
    const first = notNow();
    if (first) return first;
    try {
      // An own payment running now goes first: this run takes the storage queue after it.
      const before = await myTurn();
      if (before) return before;
      if (!(await deps.ensureBackup())) throw new Error('backup storage is not connected');
      let pulled = false;
      const t0 = now();
      let yields = 0;
      if (mode === 'full') {
        // A pull that yielded to an own payment (after a merged page) carries on here, after it, from its checkpoint.
        while ((await deps.pull()) === 'yielded') {
          yields++;
          const stop = await myTurn();
          if (stop) return stop;
        }
        pulled = true;
      }
      const t1 = now();
      pendingPush = false;
      // A push cycle is never paused (services/pushView.ts); a payment goes first before it or between backups.
      for (;;) {
        const stop = await myTurn();
        if (stop) {
          pendingPush = true;
          return stop;
        }
        if ((await deps.push()) !== 'yielded') break;
        yields++;
      }
      const t2 = now();
      if (t2 - t0 >= SLOW_SYNC_MS)
        log(
          `[deviceSync] ${mode} took ${t2 - t0} ms (${pulled ? `pull ${t1 - t0} ms, ` : ''}push ${t2 - t1} ms${yields ? `, let own payments go first ${yields}×` : ''})`,
        );
      failures = 0;
      if (!pendingPush) lastPushOkAt = Date.now();
      return { ok: true, pulled, pushed: true };
    } catch (e) {
      failures++;
      pendingPush = true;
      // A backup that answered too slowly (or is still answering): retry within TIMEOUT_BACKOFF_CAP_MS, never at the
      // 30-minute end of the ladder. A push that waits for a transaction to move on: within WAIT_BACKOFF_MS. A Store
      // payment's pushNow never waits for the back-off either way.
      const wait = retryLater(isPushWait(e) ? WAIT_BACKOFF_MS : isBackupTimeout(e) ? TIMEOUT_BACKOFF_CAP_MS : Infinity);
      log(`[deviceSync] ${mode} failed (retry in ${Math.round(wait / 60_000)} min):`, syncErrorDetail(e));
      return { ok: false, error: errText(e) };
    }
  };

  const start = (mode: 'full' | 'push') => {
    runningMode = mode;
    const r = run(mode).finally(() => {
      if (running === r) {
        running = null;
        runningMode = null;
      }
    });
    running = r;
    return r;
  };
  /**
   * One sync at a time; a request while one runs joins it. A pull asked for while only a push runs is not swallowed by
   * it (review 20, L6: the receive watcher's pull, asked because another device swept a payment, joined the debounced
   * push of the watcher's own take and pulled nothing): it waits for that push, then pulls.
   */
  const once = (mode: 'full' | 'push'): Promise<DeviceSyncResult> => {
    if (!running) return start(mode);
    if (mode === 'push' || runningMode === 'full') return running;
    // Waits until nothing but a full sync runs: a pushNow (a Store payment's backup-before-send) that started while the
    // first push ran is waited for too, never run alongside (review 20 re-check, N4).
    if (!fullAfter)
      fullAfter = (async () => {
        // Read fresh after every await (a pushNow may have started meanwhile).
        const now = () => ({ r: running as Promise<DeviceSyncResult> | null, m: runningMode as typeof runningMode });
        for (let c = now(); c.r && c.m !== 'full'; c = now()) await c.r.catch(() => undefined);
        fullAfter = null;
        return now().r ?? start('full');
      })();
    return fullAfter;
  };

  function schedule(ms: number) {
    pendingPush = true;
    if (pushTimer) clearTimer(pushTimer);
    pushTimer = setTimer(() => {
      pushTimer = null;
      if (pendingPush) void once('push');
    }, ms);
  }

  /**
   * Push now and say whether it worked (Store payments, P0 3 Nov 2026: back up a payment's rows, which hold its change
   * derivation, BEFORE it is broadcast). The push STARTS after this call, so it carries rows written just before; a run
   * already in flight is waited for, not joined. A site mid-action is waited for a little, then it is a failure.
   */
  const pushNow = async (o: { busyWaitMs?: number[]; sleep?: (ms: number) => Promise<void> } = {}) => {
    const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    if (!deps.applies()) return { ok: true, pulled: false, pushed: false } as DeviceSyncResult;
    for (const wait of o.busyWaitMs ?? [1_000, 2_000, 4_000]) {
      if (!deps.busy?.()) break;
      await sleep(wait);
    }
    if (deps.busy?.()) return { ok: false, error: 'a site action is in progress' } as DeviceSyncResult;
    while (running) await running.catch(() => undefined);
    return start('push');
  };

  return {
    /** Pull the other devices' changes, then push this device's ("Sync with my other devices", wallet open). */
    syncNow: () => once('full'),
    pushNow,
    /** Something changed here: update the backup shortly (debounced; the latest change resets the wait). */
    changed: () => {
      if (failures === 0) schedule(PUSH_DELAY_MS);
      else pendingPush = true; // a back-off retry is already scheduled and will carry it
    },
    /** For tests and diagnostics. */
    state: () => ({ failures, pendingPush, scheduled: !!pushTimer, running: !!running, lastPushOkAt }),
  };
}

export type DeviceSync = ReturnType<typeof createDeviceSync>;

/**
 * The device-sync pull: merge the backup's changes, then only SCHEDULE the chain checks for what the merge held back.
 * Awaiting them here made a Store payment's backup-before-send (60 s) wait behind a whole admission run on the first
 * open after the release, and fail with "the backup took too long" (final review 18, F-A). Admission runs outside every
 * storage lock and retries on its own timer, the alarm and app focus, so nothing depends on it finishing in the pull.
 */
export function pullThenAdmitSoon<R>(merge: () => Promise<R>, admitSoon: () => void): () => Promise<R> {
  return async () => {
    const r = await merge();
    admitSoon();
    return r;
  };
}

type Mutating = 'createAction' | 'signAction' | 'internalizeAction' | 'abortAction' | 'relinquishOutput';
const MUTATING: Mutating[] = ['createAction', 'signAction', 'internalizeAction', 'abortAction', 'relinquishOutput'];

/** Call `changed` after every wallet call that writes to storage (whether or not it succeeded: a failure can write too). */
export function notifyOnWalletChanges(wallet: unknown, changed: () => void): boolean {
  const w = wallet as Record<Mutating, ((...a: unknown[]) => Promise<unknown>) | undefined>;
  if (!w || typeof w.createAction !== 'function') return false;
  for (const name of MUTATING) {
    const fn = w[name];
    if (typeof fn !== 'function') continue;
    const call = fn.bind(w);
    w[name] = async (...a: unknown[]) => {
      try {
        return await call(...a);
      } finally {
        changed();
      }
    };
  }
  return true;
}

export type BackupBeforeSend =
  | { ok: true; how: 'pushed' | 'remote-active' | 'no-backup' }
  | { ok: false; error: string };

/**
 * Before a Store payment is broadcast, its new rows (inputs spent, change with its BRC-29 derivation) must be in the
 * encrypted remote backup (P0, 3 Nov 2026: the 28.67 BSV change of 877d2505… existed only on one device and was lost).
 *  - this device's store active, a backup configured: push now; ok only if the push went through;
 *  - the remote store active: the rows were written there (createAction runs on it): ok;
 *  - no backup configured at all: nothing to push to: ok, logged (the same as every other payment).
 * A push that fails or takes longer than `timeoutMs` is { ok: false }: the caller must not broadcast.
 */
export async function backupBeforeSend(d: {
  deviceActive: () => boolean;
  backupConfigured: () => boolean;
  pushNow: () => Promise<DeviceSyncResult>;
  timeoutMs?: number;
  log?: (m: string) => void;
}): Promise<BackupBeforeSend> {
  const log = d.log ?? ((m: string) => console.warn(m));
  if (!d.deviceActive()) return { ok: true, how: 'remote-active' };
  if (!d.backupConfigured()) {
    log('[deviceSync] no backup configured: a Store payment goes out with its rows on this device only');
    return { ok: true, how: 'no-backup' };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DeviceSyncResult>((ok) => {
    timer = setTimeout(() => ok({ ok: false, error: 'the backup took too long' }), d.timeoutMs ?? 60_000);
  });
  try {
    const r = await Promise.race([
      d.pushNow().catch((e: unknown) => ({ ok: false as const, error: errText(e) })),
      timeout,
    ]);
    if (r.ok && r.pushed) return { ok: true, how: 'pushed' };
    return { ok: false, error: r.ok ? 'the backup was not updated' : r.error };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
