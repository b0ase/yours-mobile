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

export type DeviceSyncResult = { ok: true; pulled: boolean; pushed: boolean } | { ok: false; error: string };

export type DeviceSyncDeps = {
  /** This device's store is active and a backup is configured (the only setup this applies to). */
  applies: () => boolean;
  /** Connect the configured backup if it isn't connected; resolves true when one is connected. */
  ensureBackup: () => Promise<boolean>;
  /** Bring the backup's changes into this device's store. */
  pull: () => Promise<void>;
  /** Copy this device's changes to the backup. */
  push: () => Promise<void>;
  /** A connected site is part-way through a multi-step action: don't take storage locks now. */
  busy?: () => boolean;
  log?: (...a: unknown[]) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
};

export const PUSH_DELAY_MS = 20_000;
export const BACKOFF_MS = [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000];

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createDeviceSync(deps: DeviceSyncDeps) {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const log = deps.log ?? (() => undefined);
  let running: Promise<DeviceSyncResult> | null = null;
  let pushTimer: unknown = null;
  let failures = 0;
  let pendingPush = false;

  const retryLater = () => {
    const wait = BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)];
    schedule(wait);
    return wait;
  };

  const run = async (mode: 'full' | 'push'): Promise<DeviceSyncResult> => {
    if (!deps.applies()) return { ok: true, pulled: false, pushed: false };
    if (deps.busy?.()) {
      schedule(PUSH_DELAY_MS);
      return { ok: false, error: 'a site action is in progress; sync deferred' };
    }
    try {
      if (!(await deps.ensureBackup())) throw new Error('backup storage is not connected');
      let pulled = false;
      if (mode === 'full') {
        await deps.pull();
        pulled = true;
      }
      pendingPush = false;
      await deps.push();
      failures = 0;
      return { ok: true, pulled, pushed: true };
    } catch (e) {
      failures++;
      pendingPush = true;
      const wait = retryLater();
      log(`[deviceSync] ${mode} failed (retry in ${Math.round(wait / 60_000)} min):`, errText(e));
      return { ok: false, error: errText(e) };
    }
  };

  /** One sync at a time; a request while one runs joins it. */
  const once = (mode: 'full' | 'push') => {
    if (!running) running = run(mode).finally(() => (running = null));
    return running;
  };

  function schedule(ms: number) {
    pendingPush = true;
    if (pushTimer) clearTimer(pushTimer);
    pushTimer = setTimer(() => {
      pushTimer = null;
      if (pendingPush) void once('push');
    }, ms);
  }

  return {
    /** Pull the other devices' changes, then push this device's ("Sync with my other devices", wallet open). */
    syncNow: () => once('full'),
    /** Something changed here: update the backup shortly (debounced; the latest change resets the wait). */
    changed: () => {
      if (failures === 0) schedule(PUSH_DELAY_MS);
      else pendingPush = true; // a back-off retry is already scheduled and will carry it
    },
    /** For tests and diagnostics. */
    state: () => ({ failures, pendingPush, scheduled: !!pushTimer, running: !!running }),
  };
}

export type DeviceSync = ReturnType<typeof createDeviceSync>;

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
