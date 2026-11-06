/**
 * This device's store stays the enabled active store for an account whose records live on this device
 * (P0, 5 Nov 2026: the owner's 1p test on his iPhone, candidate c49da7b0, failed with WERR_NOT_ACTIVE, and was shown as
 * "can't confirm whether it went out").
 *
 * The toolbox (WalletStorageManager.makeAvailable) puts every backup whose user row names a different active store into
 * `_conflictingActives`. While one is there `isActiveEnabled` is false, and every call that needs the active store
 * (getAuth(true): createAction, processAction, internalizeAction, abortAction, updateBackups…) throws WERR_NOT_ACTIVE.
 *
 * How the phone got there (reproduced in incident/notActive.test.ts):
 *  1. Every open writes the opening device's choice into the backup's user row: the factory's open-time setActive. The
 *     owner's Chrome extension (5.2.49, remote-active) names the remote; a device on this release names itself.
 *  2. The phone reopens and the backup's connect takes longer than the factory's 5 s limit. The factory opens with this
 *     device alone, but the connect it gave up on keeps running (addWalletStorageProvider), lands later, and re-reads
 *     the stores with the other device's choice in them. Nothing makes this device active again: the factory's
 *     setActive ran before, and its addRemote only reconnects (and heals) when a new connect fits the limit.
 *  3. isActiveStorageProvider() still says "this device", so localFirst lets the payment through to the toolbox, which
 *     refuses it at its first step. Receipts and the backup push are refused the same way, for the whole session.
 * A pull (syncFromReader) never imports the backup's choice, and an open session keeps its rows in memory, so another
 * device's open matters only when the stores are read again.
 *
 * Here, for an account whose storage config names no active remote:
 *  - whenever the stores are re-read and this device's store is not enabled, it is made active again with the toolbox's
 *    own setActive (the factory's setActiveStorage('local')): the conflicting store's records are merged into this
 *    device first, through the inbound check (services/inboundSync.ts), then every store is pointed at this device.
 *    It is the same merge the factory runs at every open;
 *  - each storage call that needs the active store does that first when needed, and once more when the toolbox still
 *    refuses it with its own WERR_NOT_ACTIVE (getAuth(true) is the first step of each of those calls, so the refused
 *    call changed nothing);
 *  - that merge holds every storage lock, so each backup request in it has a deadline (review 19, F2): a backup that
 *    stops answering fails the merge in seconds instead of blocking reads and signed payments until fetch gives up;
 *  - when the merge fails, the conflicting backup is set aside, as the factory sets aside a backup that fails at open,
 *    so this device can still pay and receive. Coins another device spent meanwhile are caught by the pre-sign coin
 *    check and the broadcaster, as with any backup out of reach (services/coinPreflight.ts);
 *  - a set-aside backup is reconnected on a back-off, never in the run that set it aside, and only after a request to it
 *    answered in time. It is added with that answer, so the toolbox makes no request to it while it re-reads its stores
 *    (review 19, F1: re-adding a dead backup wedged every read). The same backup is never registered twice (F5);
 *  - an explicit switch (Settings › Storage, Restore from backup, the move to this device) waits for a heal already
 *    running and is never undone by one (F3);
 *  - a payment that still can't start is refused before anything is built: DeviceNotActiveError, "Nothing was sent".
 * An account still on the remote store is left to localFirst's verified move.
 */

import { DEVICE_NOT_ACTIVE_MESSAGE } from '../utils/sendErrors';
import { syncErrorDetail } from './syncErrorDetail';

/** The toolbox's own refusal (WalletStorageManager.getAuth): thrown before the call does anything. */
const MANAGER_NOT_ACTIVE = /not accessing user's active storage or there are conflicting active stores/i;

/**
 * A payment refused before the toolbox built anything, because this device's store could not be made active. The code
 * stays the toolbox's WERR_NOT_ACTIVE for sites; `detail` (the toolbox's text) shows behind Details.
 */
export class DeviceNotActiveError extends Error {
  readonly code = 'WERR_NOT_ACTIVE';
  readonly isError = true;
  constructor(readonly detail = '') {
    super(DEVICE_NOT_ACTIVE_MESSAGE);
    this.name = 'WERR_NOT_ACTIVE';
  }
}

/** The toolbox manager's own WERR_NOT_ACTIVE (not a remote server's, which may come after it did some work). */
export const isManagerNotActive = (e: unknown): boolean => {
  const o = e as { name?: unknown; code?: unknown; message?: unknown } | null;
  if (!o || (o.name !== 'WERR_NOT_ACTIVE' && o.code !== 'WERR_NOT_ACTIVE')) return false;
  return typeof o.message === 'string' && MANAGER_NOT_ACTIVE.test(o.message);
};

/** Calls whose first step is getAuth(true): refused before they do anything. createAction is the one that builds. */
const ACTIVE_CALLS = [
  'createAction',
  'processAction',
  'internalizeAction',
  'abortAction',
  'relinquishOutput',
  'relinquishCertificate',
  'prepareNoSendExpiry',
  'activateNoSendExpiry',
  'armNoSendExpiry',
] as const;

/** What the toolbox's setActive (syncToWriter both ways) asks a backup: each gets a deadline during a heal. */
const BACKUP_CALLS = [
  'makeAvailable',
  'findOrInsertUser',
  'findOrInsertSyncStateAuth',
  'getSyncCheckpoint',
  'getSyncChunk',
  'processSyncChunk',
  'setActive',
] as const;

type Client = Record<string, unknown> & {
  isStorageProvider?: () => boolean;
  makeAvailable?: () => Promise<unknown>;
  findOrInsertUser?: (identityKey: string) => Promise<{ user: unknown }>;
};
type Managed = {
  storage: Client;
  settings?: { storageIdentityKey?: string };
  user?: unknown;
  isAvailable?: boolean;
  isStorageProvider?: boolean;
};
type Manager = {
  isActiveEnabled: boolean;
  isActiveStorageProvider(): boolean;
  getConflictingStores(): string[];
  getBackupStores(): string[];
  makeAvailable(): Promise<unknown>;
  runAsSync<T>(fn: (active: unknown) => Promise<T>): Promise<T>;
  _stores: Managed[];
  _conflictingActives?: Managed[];
  _isAvailable: boolean;
  _authId?: { identityKey?: string };
  __bwxDeviceActive?: KeepDeviceActive;
} & Record<string, unknown>;

export type KeepDeviceActiveDeps = {
  /** This account's records belong on this device: its storage config names no active remote. Read on every use. */
  deviceIntended: () => boolean;
  /** Make this device's store active through the toolbox: merge the conflicting stores in, then point every store here. */
  setDeviceActive: () => Promise<void>;
  log?: (...a: unknown[]) => void;
  /** How long a payment waits for a heal already running before it is refused (nothing built). Default 45 s. */
  healWaitMs?: number;
  /** Each backup request during a heal, and each reconnect probe, gets this long. Default 20 s. */
  backupCallMs?: number;
  /** After this long a heal's further backup requests fail at once, so it ends and frees the locks. Default 120 s. */
  healDeadlineMs?: number;
  /** Back-off between tries to reconnect a set-aside backup. Default 30 s, 1, 2, 5, then every 10 min. */
  retryMs?: number[];
  /** At most one automatic heal (after the stores are re-read) per this long. Default 10 s. */
  autoGapMs?: number;
};

export type BackupPause = { paused: boolean; nextRetryAt: number; failures: number };

export type KeepDeviceActive = {
  /** This device's store should be active and isn't enabled. */
  needsHeal: () => boolean;
  /** Make it active again (one at a time; a call while one runs joins it). True once it is enabled. */
  heal: (reason: string) => Promise<boolean>;
  /**
   * Reconnect the set-aside backups that are due (never one set aside in this run): a request with a deadline first,
   * then the add, then the heal. True when a backup is connected after it.
   */
  reattach: () => Promise<boolean>;
  /** A backup is set aside and retrying (the device data note says so). */
  paused: () => BackupPause;
  /** A heal (the merge that holds every storage lock) is running now. A seal skips its coin wait then (coinWait.ts). */
  healing: () => boolean;
  /** An explicit switch: waits for a running heal, and no heal undoes it. */
  userSwitch: <T>(to: 'device' | 'remote', run: () => Promise<T>) => Promise<T>;
  stop: () => void;
};

const TIMEOUT = Symbol('timeout');
/** `p` or TIMEOUT after `ms`; the timer is cleared either way. */
const within = <T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<typeof TIMEOUT>((r) => (timer = setTimeout(() => r(TIMEOUT), ms)))]).finally(() =>
    clearTimeout(timer),
  );
};
/** `p`, or a "did not answer" error after `ms` (the request itself goes on, unobserved). */
const bounded = async <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  p.catch(() => undefined);
  const r = await within(p, Math.max(0, ms));
  if (r === TIMEOUT) throw new Error(`network: the backup did not answer in time (${what})`);
  return r;
};
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Install on the wallet's WalletStorageManager, right after the factory returns (see the header). Null: not a manager. */
export function keepDeviceStoreActive(storage: unknown, d: KeepDeviceActiveDeps): KeepDeviceActive | null {
  const m = storage as Manager | null;
  if (!m || typeof m.makeAvailable !== 'function' || typeof m.runAsSync !== 'function' || !Array.isArray(m._stores))
    return null;
  if (m.__bwxDeviceActive) return m.__bwxDeviceActive;
  const log = d.log ?? ((...a: unknown[]) => console.warn(...a));
  const healWaitMs = d.healWaitMs ?? 45_000;
  const callMs = d.backupCallMs ?? 20_000;
  const retryMs = d.retryMs?.length ? d.retryMs : [30_000, 60_000, 120_000, 300_000, 600_000];
  const backoff = (failures: number) => retryMs[Math.min(Math.max(failures, 1) - 1, retryMs.length - 1)];
  let stopped = false;
  let inflight: Promise<boolean> | null = null;
  let autoTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let lastAuto = 0;
  /** An explicit switch is running, and the last one's direction (F3). */
  let switching = 0;
  let choice: 'device' | 'remote' | undefined;
  /** Backups set aside after a failed merge, by storage identity key, with their back-off. */
  const setAside = new Map<string, { client: Client; failures: number; nextAt: number }>();
  /** Failures in a row per backup, across set-aside and reconnect, for the back-off. */
  const failuresOf = new Map<string, number>();

  const intended = () => {
    if (switching > 0 || choice === 'remote') return false;
    try {
      return d.deviceIntended();
    } catch {
      return false;
    }
  };
  const deviceSelected = () => {
    try {
      return m.isActiveStorageProvider();
    } catch {
      return false; // not available (the stores are being re-read)
    }
  };
  const needsHeal = () => !stopped && !m.isActiveEnabled && deviceSelected() && intended();
  const sikOf = (s: Managed) => s.settings?.storageIdentityKey;
  const isRemote = (s: Managed) => {
    try {
      return s.storage.isStorageProvider?.() === false;
    } catch {
      return false;
    }
  };
  /** Stores registered twice (same storage identity key): every one after the first (F5). */
  const duplicates = () => {
    const seen = new Set<string>();
    return m._stores.filter((s) => {
      const k = sikOf(s);
      if (!k) return false;
      if (seen.has(k)) return true;
      seen.add(k);
      return false;
    });
  };
  /** Drop stores from this session and re-read the rest, under the sync lock (as setActive changes them). */
  const dropStores = (pick: () => Managed[]) =>
    m.runAsSync(async () => {
      const out = pick();
      if (!out.length) return [] as Managed[];
      m._stores = m._stores.filter((s) => !out.includes(s));
      m._isAvailable = false;
      await m.makeAvailable();
      return out;
    });

  const scheduleRetry = () => {
    if (stopped || retryTimer || !setAside.size) return;
    const next = Math.min(...[...setAside.values()].map((e) => e.nextAt));
    retryTimer = setTimeout(
      () => {
        retryTimer = undefined;
        void reattach();
      },
      Math.max(0, next - Date.now()),
    );
  };
  const putAside = (out: Managed[]) => {
    for (const s of out) {
      const k = sikOf(s);
      if (!k) continue;
      const failures = (failuresOf.get(k) ?? 0) + 1;
      failuresOf.set(k, failures);
      setAside.set(k, { client: s.storage, failures, nextAt: Date.now() + backoff(failures) });
    }
    scheduleRetry();
  };

  /**
   * Deadlines on every request the heal makes to a backup, for its duration only (F2). After `healDeadlineMs` all of
   * them fail at once, so the merge ends and the locks are freed. Returns the undo.
   */
  const armDeadlines = () => {
    const endsAt = Date.now() + (d.healDeadlineMs ?? 120_000);
    const undo: (() => void)[] = [];
    for (const s of m._stores.filter(isRemote)) {
      const c = s.storage as Record<string, unknown>;
      for (const name of BACKUP_CALLS) {
        const fn = c[name];
        if (typeof fn !== 'function') continue;
        const own = Object.getOwnPropertyDescriptor(c, name);
        c[name] = (...a: unknown[]) =>
          bounded(
            Promise.resolve().then(() => (fn as (...x: unknown[]) => Promise<unknown>).apply(c, a)),
            Math.min(callMs, endsAt - Date.now()),
            name,
          );
        undo.push(() => {
          if (own) Object.defineProperty(c, name, own);
          else delete c[name];
        });
      }
    }
    return () => undo.forEach((u) => u());
  };

  const run = async (reason: string): Promise<boolean> => {
    if (duplicates().length) {
      const gone = await dropStores(duplicates).catch(() => [] as Managed[]);
      if (gone.length) log(`[deviceActive] ${gone.length} backup store(s) registered twice; kept one`);
    }
    // Checked again right before the switch: an explicit switch may have started meanwhile (F3).
    if (!needsHeal()) return !!m.isActiveEnabled;
    let conflicting: string[] = [];
    try {
      conflicting = m.getConflictingStores();
    } catch {
      // not available
    }
    log(
      `[deviceActive] ${reason}: this device's store is not enabled (conflicting: ${conflicting.join(', ') || 'none'}); making it active again`,
    );
    const disarm = armDeadlines();
    try {
      await d.setDeviceActive();
    } catch (e) {
      // The whole error, the backup call and its page (services/syncErrorDetail.ts): "An internal error has occurred."
      // alone could not say which call failed (owner's iPhone, 6 Nov 2026).
      log('[deviceActive] the merge did not complete:', syncErrorDetail(e));
    } finally {
      disarm();
    }
    if (needsHeal()) {
      const out = await dropStores(() => m._conflictingActives ?? []).catch((err: unknown) => {
        log('[deviceActive] could not set the backup aside:', errText(err));
        return [] as Managed[];
      });
      putAside(out);
      if (out.length) log(`[deviceActive] ${out.length} backup store(s) set aside for now; reconnecting on a back-off`);
    }
    const ok = !!m.isActiveEnabled;
    if (ok) for (const s of m._stores) if (sikOf(s) && !setAside.has(sikOf(s)!)) failuresOf.delete(sikOf(s)!);
    log(
      ok ? '[deviceActive] this device is the active store' : "[deviceActive] this device's store is still not enabled",
    );
    return ok;
  };

  const heal = (reason: string): Promise<boolean> => {
    if (!needsHeal() && !duplicates().length) return Promise.resolve(!!m.isActiveEnabled);
    if (!inflight)
      inflight = run(reason)
        .catch(() => false)
        .finally(() => {
          inflight = null;
        });
    return inflight;
  };

  const scheduleHeal = () => {
    if (stopped || autoTimer || inflight) return;
    autoTimer = setTimeout(
      () => {
        autoTimer = undefined;
        if (!needsHeal() && !duplicates().length) return;
        lastAuto = Date.now();
        void heal('the stores were re-read');
      },
      Math.max(0, lastAuto + (d.autoGapMs ?? 10_000) - Date.now()),
    );
  };

  /** Reconnect one set-aside backup: a request with a deadline, then an add that makes no request (F1). */
  const reattachOne = async (key: string, entry: { client: Client; failures: number; nextAt: number }) => {
    if (m._stores.some((s) => sikOf(s) === key)) {
      setAside.delete(key); // connected again some other way (a late connect, addRemote): never twice (F5)
      return;
    }
    const identityKey = m._authId?.identityKey;
    const c = entry.client;
    try {
      if (!identityKey || typeof c.makeAvailable !== 'function' || typeof c.findOrInsertUser !== 'function')
        throw new Error('not a storage client');
      const settings = (await bounded(
        Promise.resolve().then(() => c.makeAvailable!()),
        callMs,
        'makeAvailable',
      )) as Managed['settings'];
      const found = await bounded(
        Promise.resolve().then(() => c.findOrInsertUser!(identityKey)),
        callMs,
        'findOrInsertUser',
      );
      await m.runAsSync(async () => {
        if (m._stores.some((s) => sikOf(s) === key)) return;
        // The toolbox's ManagedStorage, filled in from the probe: re-reading the stores makes no request to it.
        const Ctor = m._stores[0]?.constructor as (new (s: unknown) => Managed) | undefined;
        const ms: Managed = Ctor && (Ctor as unknown) !== Object ? new Ctor(c) : { storage: c };
        Object.assign(ms, { storage: c, isStorageProvider: false, settings, user: found.user, isAvailable: true });
        m._stores = [...m._stores, ms];
        m._isAvailable = false;
        try {
          await m.makeAvailable();
        } catch (e) {
          m._stores = m._stores.filter((s) => s !== ms);
          m._isAvailable = false;
          await m.makeAvailable();
          throw e;
        }
      });
      setAside.delete(key);
      log('[deviceActive] the set-aside backup answered and is connected again');
    } catch (e) {
      const failures = (failuresOf.get(key) ?? entry.failures) + 1;
      failuresOf.set(key, failures);
      entry.failures = failures;
      entry.nextAt = Date.now() + backoff(failures);
      log('[deviceActive] the set-aside backup is still not answering:', errText(e));
    }
  };

  const reattach = async (): Promise<boolean> => {
    if (stopped) return false;
    for (const [key, entry] of [...setAside]) if (entry.nextAt <= Date.now()) await reattachOne(key, entry);
    if (needsHeal() || duplicates().length) await heal('a backup reconnected');
    scheduleRetry();
    try {
      return m.getBackupStores().length > 0;
    } catch {
      return false;
    }
  };

  // A store joining (a late connect, a reconnect) re-reads every store: heal right after, outside every lock.
  const makeAvailable = m.makeAvailable.bind(m);
  m.makeAvailable = async () => {
    const r = await makeAvailable();
    if (needsHeal() || duplicates().length) scheduleHeal();
    return r;
  };

  /** createAction refused by the manager itself built nothing: say so plainly. Anything else passes unchanged. */
  const refused = (name: string, e: unknown) =>
    name === 'createAction' && isManagerNotActive(e)
      ? new DeviceNotActiveError(e instanceof Error ? e.message : String(e))
      : e;
  for (const name of ACTIVE_CALLS) {
    const original = m[name];
    if (typeof original !== 'function') continue;
    const call = (original as (...a: unknown[]) => Promise<unknown>).bind(m);
    m[name] = async (...a: unknown[]) => {
      if (needsHeal()) {
        const healed = await within(heal(name), healWaitMs);
        // Still running: the merge holds every storage lock, so the call would only queue behind it.
        if (healed === TIMEOUT && name === 'createAction') throw new DeviceNotActiveError('the heal is still running');
      }
      try {
        return await call(...a);
      } catch (e) {
        if (!isManagerNotActive(e) || !needsHeal()) throw refused(name, e);
        log(`[deviceActive] ${name} was refused as not active; healing and trying it once more`);
        if ((await within(heal(name), healWaitMs)) !== true) throw refused(name, e);
        try {
          return await call(...a);
        } catch (again) {
          throw refused(name, again);
        }
      }
    };
  }
  // The late connect may have landed before this was installed.
  if (needsHeal() || duplicates().length) scheduleHeal();

  return (m.__bwxDeviceActive = {
    needsHeal,
    heal,
    reattach,
    healing: () => !!inflight,
    paused: () => {
      const all = [...setAside.values()];
      return {
        paused: all.length > 0,
        nextRetryAt: all.length ? Math.min(...all.map((e) => e.nextAt)) : 0,
        failures: all.reduce((n, e) => Math.max(n, e.failures), 0),
      };
    },
    userSwitch: async <T>(to: 'device' | 'remote', switchNow: () => Promise<T>): Promise<T> => {
      switching++;
      if (autoTimer) clearTimeout(autoTimer);
      autoTimer = undefined;
      try {
        // A heal already running finishes first; then this switch, which nothing undoes.
        if (inflight) await inflight.catch(() => false);
        choice = to;
        return await switchNow();
      } finally {
        switching--;
      }
    },
    stop: () => {
      stopped = true;
      if (autoTimer) clearTimeout(autoTimer);
      if (retryTimer) clearTimeout(retryTimer);
      autoTimer = undefined;
      retryTimer = undefined;
    },
  });
}

/** ctx.setActiveStorage: every explicit switch goes through userSwitch, so no heal undoes it (review 19, F3). */
export const switchActiveAs =
  (keep: KeepDeviceActive | null, setActiveStorage: (target: 'local' | string) => Promise<void>) =>
  (target: 'local' | string): Promise<void> =>
    keep
      ? keep.userSwitch(target === 'local' ? 'device' : 'remote', () => setActiveStorage(target))
      : setActiveStorage(target);

/**
 * Device sync's "connect the backup" step (initWallet's ensureBackup). True when a backup is connected:
 *  - a backup naming another store is merged and this device made active again first;
 *  - a set-aside backup is only ever reconnected by reattach (a probe first, on its back-off), never by a fresh
 *    connect, and never in the run that set it aside (review 19, F1);
 *  - while a backup still conflicts, no second connection is opened (F5);
 *  - otherwise the factory's addRemote, with a time limit.
 */
export async function ensureBackupConnected(d: {
  storage: { getBackupStores(): string[]; getConflictingStores(): string[] };
  keep: KeepDeviceActive | null;
  url: string | undefined;
  addRemote: (url: string) => Promise<void>;
  connectWaitMs?: number;
}): Promise<boolean> {
  const count = (f: () => string[]) => {
    try {
      return f().length;
    } catch {
      return 0;
    }
  };
  const backups = () => count(() => d.storage.getBackupStores());
  if (d.keep?.needsHeal()) await d.keep.heal('device sync');
  if (backups() > 0) return true;
  if (d.keep?.paused().paused) return d.keep.reattach();
  if (count(() => d.storage.getConflictingStores()) > 0) return false;
  if (!d.url) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      d.addRemote(d.url),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('backup connect timed out')), d.connectWaitMs ?? 20_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  return backups() > 0;
}
