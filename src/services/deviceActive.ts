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
 *  - when the merge itself fails (the backup dropped mid-way), the conflicting backup is set aside for this session, as
 *    the factory sets aside a backup that fails at open, so this device can still pay and receive. Device sync
 *    reconnects it (reattach) and the merge runs then. Coins another device spent meanwhile are caught by the pre-sign
 *    coin check and the broadcaster, as with any backup that is out of reach (services/coinPreflight.ts);
 *  - a payment that still can't start is refused before anything is built: DeviceNotActiveError, "Nothing was sent".
 * An account still on the remote store is left to localFirst's verified move.
 */

import { DEVICE_NOT_ACTIVE_MESSAGE } from '../utils/sendErrors';

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

type Managed = { storage: unknown };
type Manager = {
  isActiveEnabled: boolean;
  isActiveStorageProvider(): boolean;
  getConflictingStores(): string[];
  makeAvailable(): Promise<unknown>;
  addWalletStorageProvider(p: unknown): Promise<void>;
  runAsSync<T>(fn: (active: unknown) => Promise<T>): Promise<T>;
  _stores: Managed[];
  _conflictingActives?: Managed[];
  _isAvailable: boolean;
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
  /** How long device sync waits for a set-aside backup to reconnect. Default 20 s. */
  reattachWaitMs?: number;
  /** At most one automatic heal (after the stores are re-read) per this long. Default 10 s. */
  autoGapMs?: number;
};

export type KeepDeviceActive = {
  /** This device's store should be active and isn't enabled. */
  needsHeal: () => boolean;
  /** Make it active again (one at a time; a call while one runs joins it). True once it is enabled. */
  heal: (reason: string) => Promise<boolean>;
  /** Reconnect backups set aside after a failed merge (device sync). True when a backup is connected after it. */
  reattach: () => Promise<boolean>;
  stop: () => void;
};

const within = <T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), ms)))]).finally(() =>
    clearTimeout(timer),
  );
};

/** Install on the wallet's WalletStorageManager, right after the factory returns (see the header). Null: not a manager. */
export function keepDeviceStoreActive(storage: unknown, d: KeepDeviceActiveDeps): KeepDeviceActive | null {
  const m = storage as Manager | null;
  if (!m || typeof m.makeAvailable !== 'function' || typeof m.runAsSync !== 'function' || !Array.isArray(m._stores))
    return null;
  if (m.__bwxDeviceActive) return m.__bwxDeviceActive;
  const log = d.log ?? ((...a: unknown[]) => console.warn(...a));
  const healWaitMs = d.healWaitMs ?? 45_000;
  let stopped = false;
  let inflight: Promise<boolean> | null = null;
  let autoTimer: ReturnType<typeof setTimeout> | undefined;
  let lastAuto = 0;
  /** Backups set aside after a failed merge, to reconnect later. */
  const setAside: unknown[] = [];

  const intended = () => {
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

  /** After a failed merge: this session goes on without the conflicting backups (under the sync lock, as setActive). */
  const setConflictsAside = async (): Promise<number> =>
    m.runAsSync(async () => {
      const conflicting = m._conflictingActives ?? [];
      if (!conflicting.length) return 0;
      const out = new Set(conflicting);
      m._stores = m._stores.filter((s) => !out.has(s));
      for (const s of conflicting) setAside.push(s.storage);
      m._isAvailable = false;
      await m.makeAvailable();
      return conflicting.length;
    });

  const run = async (reason: string): Promise<boolean> => {
    const conflicting = (() => {
      try {
        return m.getConflictingStores();
      } catch {
        return [];
      }
    })();
    log(
      `[deviceActive] ${reason}: this device's store is not enabled (conflicting: ${conflicting.join(', ') || 'none'}); making it active again`,
    );
    try {
      await d.setDeviceActive();
    } catch (e) {
      log('[deviceActive] the merge did not complete:', e instanceof Error ? e.message : e);
      if (needsHeal()) {
        const n = await setConflictsAside().catch((err: unknown) => {
          log('[deviceActive] could not set the backup aside:', err instanceof Error ? err.message : err);
          return 0;
        });
        if (n) log(`[deviceActive] ${n} backup store(s) set aside for this session; device sync reconnects them`);
      }
    }
    const ok = !!m.isActiveEnabled;
    log(
      ok ? '[deviceActive] this device is the active store' : "[deviceActive] this device's store is still not enabled",
    );
    return ok;
  };

  const heal = (reason: string): Promise<boolean> => {
    if (!needsHeal()) return Promise.resolve(!!m.isActiveEnabled);
    if (!inflight)
      inflight = run(reason)
        .catch(() => false)
        .finally(() => {
          inflight = null;
        });
    return inflight;
  };

  const scheduleHeal = () => {
    if (autoTimer || inflight) return;
    autoTimer = setTimeout(
      () => {
        autoTimer = undefined;
        if (!needsHeal()) return;
        lastAuto = Date.now();
        void heal('the stores were re-read');
      },
      Math.max(0, lastAuto + (d.autoGapMs ?? 10_000) - Date.now()),
    );
  };

  // A store joining (a late connect, a reconnect) re-reads every store: heal right after, outside every lock.
  const makeAvailable = m.makeAvailable.bind(m);
  m.makeAvailable = async () => {
    const r = await makeAvailable();
    if (needsHeal()) scheduleHeal();
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
        if (healed === 'timeout' && name === 'createAction')
          throw new DeviceNotActiveError('the heal is still running');
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
  if (needsHeal()) scheduleHeal();

  return (m.__bwxDeviceActive = {
    needsHeal,
    heal,
    reattach: async () => {
      const waiting = setAside.splice(0);
      for (const client of waiting) {
        const r = await within(
          m.addWalletStorageProvider(client).then(() => 'ok' as const),
          d.reattachWaitMs ?? 20_000,
        ).catch((e: unknown) => {
          log('[deviceActive] a set-aside backup did not reconnect:', e instanceof Error ? e.message : e);
          return 'failed' as const;
        });
        if (r === 'failed') setAside.push(client);
      }
      if (needsHeal()) await heal('a backup reconnected');
      try {
        return (m as unknown as { getBackupStores(): string[] }).getBackupStores().length > 0;
      } catch {
        return false;
      }
    },
    stop: () => {
      stopped = true;
      if (autoTimer) clearTimeout(autoTimer);
      autoTimer = undefined;
    },
  });
}
