/**
 * How this device's pulls from the backup are doing, for a one-line status in the UI (balance integrity plan, fix 3).
 *
 * The extension's pull from the start froze on 8 Nov 2026 (0 progress, never gave up) and the phone's merged payments
 * without their coins: neither said anything on screen. This keeps, per open wallet:
 *  - lastPullOkAt: the last device-sync pull that caught up with the backup (every page merged, no pass under
 *    way). Persisted in this device store's sync state for the backup (FullPassMark.pullOkAt), read back at open.
 *  - stuck + reason:
 *      'failing'          pulls have failed for STUCK_PASS_MS (30 min) of wallet uptime in a row;
 *      'no-progress'      a pass under way hasn't moved for 30 min of uptime and can't be given up (fullPass 'stuck');
 *      'missing-outputs'  payments arrived without their coins and the targeted re-pulls didn't bring them (a full
 *                         pass is asked for; "Find missing coins" can copy them in meanwhile).
 *  - lastAttemptAt / attempted: the last pull tried, and whether one has been since the wallet opened.
 *  - missingOutputs / healing: payments still waiting for coins, and whether a heal pass is bringing them.
 *  - changeNotBackedUp: payments that went out before their change reached the backup (services/changeWriteAhead.ts).
 * Pulls run at open, on a wallet page coming to the front (last good pull older than 5 min) and on a timer (older than
 * 1 h), and a failed or deferred pull is retried as a pull (services/deviceSync.ts pullIfStale, review of fix 5).
 * Read it with syncHealth() (the open wallet's), or the wallet context's backupState().health; subscribe with
 * onSyncHealth(cb). Nothing here decides what is spendable.
 */
import { STUCK_PASS_MS, type FullPassPlan } from './fullPass';
import type { IntegrityReport } from './pullIntegrity';

export type SyncHealthReason = 'failing' | 'no-progress' | 'missing-outputs';

export type SyncHealth = {
  /** The last pull that caught up with the backup (ms since epoch); 0: none recorded on this device. */
  lastPullOkAt: number;
  /** The last pull tried (ms); 0 before the first. */
  lastAttemptAt: number;
  /** A pull has been tried since the wallet opened (false: the line has nothing to say yet). */
  attempted: boolean;
  /** The last pull's error, while pulls are failing. */
  lastError?: string;
  /** A pass is part-way (a slice ended, or a pass from the start / deep / heal pass is being carried). */
  passUnderWay: boolean;
  /** Something needs the owner's attention: see `reason`. */
  stuck: boolean;
  reason?: SyncHealthReason;
  /** Payments from the backup still waiting for some of their coins on this device. */
  missingOutputs: number;
  /** A heal pass is bringing them. */
  healing: boolean;
  /** The last pass given up as stuck (ms); the ordinary pulls ran again after it. */
  lastAbandonedAt?: number;
  /**
   * Payments broadcast while their rows (their change, with its derivation) could not reach the backup, not pushed since
   * (services/changeWriteAhead.ts, fix 4): "1 payment's change not backed up yet". Retried urgently; 0 once a push lands.
   */
  changeNotBackedUp: number;
};

export const EMPTY_SYNC_HEALTH: SyncHealth = {
  lastPullOkAt: 0,
  lastAttemptAt: 0,
  attempted: false,
  passUnderWay: false,
  stuck: false,
  missingOutputs: 0,
  healing: false,
  changeNotBackedUp: 0,
};

/** Each failed attempt counts at most this much uptime since the one before (the wallet may have been asleep). */
const UPTIME_GAP_MS = 5 * 60_000;

export function createSyncHealth(o: { now?: () => number } = {}) {
  const now = o.now ?? Date.now;
  let h: SyncHealth = { ...EMPTY_SYNC_HEALTH };
  let failingMs = 0;
  let lastFailAt: number | undefined;
  let noProgress = false;
  let givenUp = 0;
  const subs = new Set<(h: SyncHealth) => void>();
  const publish = () => {
    const reason: SyncHealthReason | undefined =
      failingMs >= STUCK_PASS_MS ? 'failing' : noProgress ? 'no-progress' : givenUp > 0 ? 'missing-outputs' : undefined;
    h = { ...h, stuck: !!reason, reason };
    for (const cb of subs)
      try {
        cb(h);
      } catch {
        // a listener's problem
      }
  };
  return {
    get: (): SyncHealth => h,
    subscribe(cb: (h: SyncHealth) => void) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    /** The persisted time of the last caught-up pull (at open, or from a report). */
    hydrate(pullOkAt: number | undefined) {
      if (typeof pullOkAt === 'number' && pullOkAt > h.lastPullOkAt) {
        h = { ...h, lastPullOkAt: pullOkAt };
        publish();
      }
    },
    attempt() {
      h = { ...h, lastAttemptAt: now(), attempted: true };
      publish();
    },
    /** What the schedule said before the pull (fullPass requestFullPass). */
    plan(p: FullPassPlan | undefined) {
      if (p === 'stuck') noProgress = true;
      if (p === 'abandoned') {
        noProgress = false;
        h = { ...h, lastAbandonedAt: now() };
      }
      publish();
    },
    /** The pull went through; `r` is the integrity check after it (undefined: not run). */
    succeeded(r?: IntegrityReport) {
      failingMs = 0;
      lastFailAt = undefined;
      const caughtUp = !!r?.caughtUp;
      if (caughtUp) noProgress = false;
      if (r) {
        givenUp = r.givenUp;
        h = {
          ...h,
          lastError: undefined,
          passUnderWay: !caughtUp,
          missingOutputs: r.knownMissing,
          healing: r.plan === 'healing' || (h.healing && !caughtUp),
          // Part-way, the persisted time still says when it last caught up (read back after a restart).
          lastPullOkAt: Math.max(h.lastPullOkAt, r.pullOkAt ?? (caughtUp ? now() : 0)),
        };
      } else h = { ...h, lastError: undefined };
      publish();
    },
    /** The write-ahead's count of payments whose change is not in the backup yet (services/changeWriteAhead.ts). */
    changeNotBackedUp(n: number) {
      const v = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
      if (v === h.changeNotBackedUp) return;
      h = { ...h, changeNotBackedUp: v };
      publish();
    },
    failed(e: unknown) {
      const t = now();
      if (lastFailAt !== undefined) failingMs += Math.min(Math.max(0, t - lastFailAt), UPTIME_GAP_MS);
      lastFailAt = t;
      h = { ...h, lastError: e instanceof Error ? e.message : String(e) };
      publish();
    },
  };
}

export type SyncHealthTracker = ReturnType<typeof createSyncHealth>;

let current: SyncHealthTracker | undefined;
const listeners = new Set<(h: SyncHealth) => void>();
let unsubCurrent: (() => void) | undefined;

/**
 * The open wallet registers its tracker (initWallet). Returns its unregister, which clears only that tracker: an account
 * switch can open the next wallet (registering its own) before the old one closes.
 */
export function registerSyncHealth(t: SyncHealthTracker | undefined): () => void {
  unsubCurrent?.();
  unsubCurrent = undefined;
  current = t;
  if (t) unsubCurrent = t.subscribe((h) => listeners.forEach((cb) => cb(h)));
  const h = syncHealth();
  listeners.forEach((cb) => cb(h));
  return () => {
    if (t && current === t) registerSyncHealth(undefined);
  };
}

/** The open wallet's pull health (EMPTY_SYNC_HEALTH when no wallet with a backup is open). */
export const syncHealth = (): SyncHealth => current?.get() ?? EMPTY_SYNC_HEALTH;

/** Called on every change to the open wallet's pull health; returns the unsubscribe. */
export function onSyncHealth(cb: (h: SyncHealth) => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

// ── the per-account pull record the UI line reads (fix 5: services/balanceTruth.ts) ──

/** chrome.storage.local key of the account's pull record. */
export const deviceSyncPullKey = (identityAddress: string) => `deviceSyncPull:${identityAddress}`;

/**
 * The record's fields (ms since epoch), read by the balance card's sync line (services/balanceTruth.ts syncLine): okAt
 * the last pull that went through and wasn't stuck, failingSince/error since the last good one, failAt the last that
 * failed, attemptAt the last attempt started (newer than okAt and old: an attempt never finished), stuck. One writer:
 * initWallet's device-sync pull, through createPullRecord.
 */
export type DeviceSyncPullRecord = { okAt?: number; failAt?: number; attemptAt?: number; stuck?: boolean };

export type PullRecordKv = {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
};

/**
 * Merge `patch` into the account's pull record (other fields, and other writers' fields, kept). Writes are chained so
 * an attempt and its result never land out of order; a storage failure is swallowed (a status line only).
 */
export function createPullRecord(kv: PullRecordKv, identityAddress: string | undefined) {
  let chain: Promise<void> = Promise.resolve();
  return (
    patch: DeviceSyncPullRecord | ((prev: Record<string, unknown>) => Record<string, unknown>),
  ): Promise<void> => {
    if (!identityAddress) return Promise.resolve();
    const key = deviceSyncPullKey(identityAddress);
    chain = chain
      .then(async () => {
        const had = (await kv.get(key))?.[key];
        const prev = had && typeof had === 'object' ? (had as Record<string, unknown>) : {};
        // An updater sees the stored record (services/balanceTruth.ts nextDeviceSyncHealth keeps fields it doesn't own).
        await kv.set({ [key]: typeof patch === 'function' ? patch(prev) : { ...prev, ...patch } });
      })
      .catch(() => undefined);
    return chain;
  };
}
