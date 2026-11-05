/**
 * Every account's records live on this device; the remote store (wallet.1sat.app) is only the backup
 * (P0, 3 Nov 2026; owner's "build the store fix", CEO-approved scope).
 *
 * New accounts start with the remote store active (utils/constants.ts DEFAULT_ACCOUNT). While it is active,
 * createAction runs on wallet.1sat.app, which builds its own random change: the seed-derived change (feat/seed-change)
 * applies only on this device's store, and the device's copy (the one deviceSync backs up and the Store's
 * backup-before-broadcast pushes) is not the one being written. So:
 *  1. On every wallet open, for every account still on the remote store (whatever its old "localFirst" flag says),
 *     verify or create the device copy and make it active (services/restoreFromRemote.ts switchToLocalVerified: the
 *     remote's records are merged in, counted, pulled again if short, and the remote is made active again on any
 *     failure, so nothing is lost). An already-local account whose device store is empty has the backup's records
 *     pulled INTO the device store, which stays active throughout: once an account is on this device, an open never
 *     makes the remote active again (release click-through, 4 Nov 2026: the old switch here flipped the active store
 *     to wallet.1sat.app for seconds on every open of an empty wallet, and left it there when the backup was slow,
 *     so Recover change refused or hit the toolbox's "does not support StorageProvider" error).
 *  2. HARD RULE: no payment builds change while the remote store is active. A createAction that builds a transaction
 *     first gets the device store made active (waiting for a switch already running); if that can't be done it is
 *     refused with a plain message, and nothing is signed.
 */
import type { SwitchResult } from './restoreFromRemote';

export type StoreConfigLike = { activeRemote?: string; remotes?: string[]; localFirst?: boolean } | undefined;

/** The remote this account backs up to (the active one first). */
export const remoteUrlOf = (c: StoreConfigLike): string | undefined => c?.activeRemote || c?.remotes?.[0] || undefined;

/** Is this account's active store this device's own? (No storage config at all is a device-only account.) */
export const isOnDeviceStore = (c: StoreConfigLike): boolean => !c?.activeRemote;

/**
 * Where this account's records are, for the honest copy (review 4 Nov 2026, F11):
 *  - 'remote': still on the online backup store (it moves to this device on open);
 *  - 'device-only': on this device, but the backup is not confirmed up to date (no backup set up, a push waiting or
 *    failing): the change of recent payments may exist only in this device's data;
 *  - 'backup-paused': on this device; the backup stopped answering during a merge and is set aside, reconnecting by
 *    itself on a back-off (services/deviceActive.ts, review 19 F4): nothing is backed up until it answers;
 *  - 'up-to-date': on this device and the last push to the backup went through with nothing waiting.
 */
export type DeviceDataState = 'remote' | 'device-only' | 'backup-paused' | 'up-to-date';

export const DEVICE_DATA_COPY: Record<DeviceDataState, string> = {
  remote:
    "This account's records are still on the online backup. They move to this device when the wallet opens; payments wait until then.",
  'device-only': "This account's change may need your device data. Keep this device until it shows Up to date.",
  'backup-paused':
    "Your online backup isn't answering, so it's paused and retrying by itself. This account's change may need your device data. Keep this device until it shows Up to date.",
  'up-to-date': "Up to date. This account's records are on this device and in your backup.",
};
/** The owner's copy, word for word (the 'device-only' state). */
export const DEVICE_DATA_NOTE = DEVICE_DATA_COPY['device-only'];
export const DEVICE_DATA_UP_TO_DATE = DEVICE_DATA_COPY['up-to-date'];

/** The state from the background's answers (STORAGE_MOVE_STATUS onDevice + the backup's last push). */
export function deviceDataState(s: {
  onDevice: boolean;
  backupConfigured: boolean;
  pendingPush: boolean;
  failures: number;
  lastPushOkAt: number;
  paused?: boolean;
}): DeviceDataState {
  if (!s.onDevice) return 'remote';
  if (s.paused) return 'backup-paused';
  if (!s.backupConfigured || s.pendingPush || s.failures > 0 || !s.lastPushOkAt) return 'device-only';
  return 'up-to-date';
}

export const LOCAL_STORE_NEEDED_CODE = 'WERR_LOCAL_STORE_NEEDED';
export const LOCAL_STORE_NEEDED_MESSAGE =
  'This account is still moving to this device, so it can\'t make payments yet. Nothing was sent. Tap "Retry moving this account to this device" (on your wallet\'s home, or Settings › Remote backup) to try now; it also retries by itself.';

export class LocalStoreNeededError extends Error {
  readonly code = LOCAL_STORE_NEEDED_CODE;
  readonly isError = true;
  constructor(message = LOCAL_STORE_NEEDED_MESSAGE) {
    super(message);
    this.name = LOCAL_STORE_NEEDED_CODE;
  }
}

export type EnsureLocalDeps = {
  /** The open account: its id and storage config, or null. */
  account: () => { id: string; config: StoreConfigLike } | null;
  /** A recent move for this account failed: wait for its backoff (the user's Retry clears it). */
  failedThisSession: (id: string) => boolean;
  /** A master backup is exporting accounts: never switch under it. */
  backupInFlight: () => boolean;
  /** This device's store is the active one right now. */
  isLocalActive: () => boolean;
  switchVerified: (remoteUrl: string) => Promise<SwitchResult>;
  /** The device's store, while active, holds nothing (the 14 Oct "empty after restore" state). */
  localIsEmpty: () => Promise<boolean>;
  /**
   * Copy the backup's records into this device's store while it stays the active one (the toolbox's syncFromReader).
   * Never changes which store is active.
   */
  pullIntoLocal: (remoteUrl: string) => Promise<void>;
  save: (config: NonNullable<StoreConfigLike>) => Promise<void>;
  /** After a failed switch (the background marks it and rebuilds the wallet on the backup if storage broke). */
  onFailed: (id: string) => Promise<void>;
  /** "Loading your wallet from backup…" status: undefined = done, null = done without the copy. */
  status?: (m: string | undefined | null) => void;
  log?: (...a: unknown[]) => void;
};

export type EnsureLocalResult =
  | { ok: true; how: 'switched' | 'already-local' | 'no-remote' | 'pulled' }
  /** This device stays active; pulling the backup's records into it failed (the next open or sync tries again). */
  | { ok: true; how: 'pull-failed'; reason?: string }
  | { ok: false; how: 'failed' | 'failed-this-session' | 'busy' | 'no-account'; reason?: string };

/** Make this device's store the active one for the open account (see the header). Never throws. */
export async function ensureLocalStore(d: EnsureLocalDeps): Promise<EnsureLocalResult> {
  const log = d.log ?? (() => undefined);
  try {
    const a = d.account();
    if (!a) return d.isLocalActive() ? { ok: true, how: 'already-local' } : { ok: false, how: 'no-account' };
    const config = a.config;
    const remoteUrl = remoteUrlOf(config);
    if (!config || !remoteUrl)
      return d.isLocalActive() ? { ok: true, how: 'no-remote' } : { ok: false, how: 'no-account' };
    if (d.failedThisSession(a.id))
      return d.isLocalActive() ? { ok: true, how: 'already-local' } : { ok: false, how: 'failed-this-session' };
    if (d.backupInFlight()) return d.isLocalActive() ? { ok: true, how: 'already-local' } : { ok: false, how: 'busy' };
    const remotes = config.remotes?.includes(remoteUrl) ? config.remotes : [...(config.remotes ?? []), remoteUrl];

    if (config.activeRemote || !d.isLocalActive()) {
      log('[localFirst] the remote store is active: verifying the device copy, then switching to it');
      const r = await d.switchVerified(remoteUrl);
      d.status?.(r.ok ? undefined : null);
      if (r.ok) {
        await d.save({ ...config, activeRemote: undefined, remotes, localFirst: true });
        return { ok: true, how: 'switched' };
      }
      log('[localFirst] switch not verified; staying on the backup for now:', r.reason);
      await d.onFailed(a.id);
      return { ok: false, how: 'failed', reason: r.reason };
    }

    // Already local-active: an EMPTY device store beside a backup is the incident state ($bug, 14 Oct 2026). Pull the
    // backup's records into this device's store; it stays the active one throughout, and nothing is saved, so a slow
    // or failing backup can never put the account back on the remote (release click-through, 4 Nov 2026).
    if (!(await d.localIsEmpty())) return { ok: true, how: 'already-local' };
    log('[localFirst] this device holds nothing; pulling the backup into it (this device stays the active store)');
    try {
      await d.pullIntoLocal(remoteUrl);
      d.status?.(undefined);
      return { ok: true, how: 'pulled' };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      log('[localFirst] could not pull the backup into this device yet; it stays the active store:', reason);
      d.status?.(null);
      return { ok: true, how: 'pull-failed', reason };
    }
  } catch (e) {
    d.status?.(null);
    log('[localFirst] could not settle the active store:', e);
    return { ok: false, how: 'failed', reason: e instanceof Error ? e.message : String(e) };
  }
}

type CreateArgs = { inputs?: unknown[]; outputs?: unknown[] } | undefined;

/** Does this createAction build a transaction (and so change)? A sendWith-only call builds nothing. */
export const buildsTransaction = (args: CreateArgs): boolean =>
  (args?.inputs?.length ?? 0) > 0 || (args?.outputs?.length ?? 0) > 0;

/**
 * Wrap wallet.createAction: a call that builds a transaction runs only with this device's store active. If the remote
 * is active, `ensureLocal` is asked to make the device store active first (it joins a switch already running); if the
 * remote is still active after that, LocalStoreNeededError is thrown before anything is built or signed.
 * Returns false when there is no createAction to wrap.
 */
export function requireLocalStoreForChange(
  wallet: unknown,
  d: { isLocal: () => boolean; ensureLocal?: () => Promise<boolean>; log?: (m: string) => void },
): boolean {
  const w = wallet as { createAction?: (args: CreateArgs, originator?: string) => Promise<unknown> } | null;
  if (!w || typeof w.createAction !== 'function') return false;
  const original = w.createAction.bind(w);
  const log = d.log ?? ((m: string) => console.warn(m));
  w.createAction = async (args: CreateArgs, originator?: string) => {
    if (buildsTransaction(args) && !d.isLocal()) {
      log('[localFirst] a payment would build change on the remote store: making this device active first');
      const ok = d.ensureLocal ? await d.ensureLocal().catch(() => false) : false;
      if (!ok || !d.isLocal()) {
        log('[localFirst] the device store is not active: payment refused, nothing built');
        throw new LocalStoreNeededError();
      }
    }
    return original(args, originator);
  };
  return true;
}
