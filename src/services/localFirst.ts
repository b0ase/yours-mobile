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
 *     failure, so nothing is lost). An already-local account whose device store is empty is pulled in the same way.
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

/** Shown on the restore screen and in Show my 12 words for an account not yet on this device's store. */
export const DEVICE_DATA_NOTE =
  "This account's change may need your device data. Keep this device until it shows Up to date.";
/** The same place once the account is on this device's store. */
export const DEVICE_DATA_UP_TO_DATE = "Up to date. This account's records are on this device and in your backup.";

export const LOCAL_STORE_NEEDED_CODE = 'WERR_LOCAL_STORE_NEEDED';
export const LOCAL_STORE_NEEDED_MESSAGE =
  "This account is still moving to this device, so it can't make payments yet. Keep the app open until it shows Up to date, then try again. Nothing was sent.";

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
  /** A switch for this account already broke storage this session: don't try again until the next start. */
  failedThisSession: (id: string) => boolean;
  /** A master backup is exporting accounts: never switch under it. */
  backupInFlight: () => boolean;
  /** This device's store is the active one right now. */
  isLocalActive: () => boolean;
  switchVerified: (remoteUrl: string) => Promise<SwitchResult>;
  /** The device's store, while active, holds nothing (the 14 Oct "empty after restore" state). */
  localIsEmpty: () => Promise<boolean>;
  save: (config: NonNullable<StoreConfigLike>) => Promise<void>;
  /** After a failed switch (the background marks it and rebuilds the wallet on the backup if storage broke). */
  onFailed: (id: string) => Promise<void>;
  /** "Loading your wallet from backup…" status: undefined = done, null = done without the copy. */
  status?: (m: string | undefined | null) => void;
  log?: (...a: unknown[]) => void;
};

export type EnsureLocalResult =
  | { ok: true; how: 'switched' | 'already-local' | 'no-remote' | 'pulled' }
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

    // Already local-active: an EMPTY device store beside a backup is the incident state ($bug, 14 Oct 2026).
    if (!(await d.localIsEmpty())) return { ok: true, how: 'already-local' };
    log('[localFirst] this device holds nothing; loading from the backup');
    const r = await d.switchVerified(remoteUrl);
    d.status?.(r.ok ? undefined : null);
    if (r.ok) return { ok: true, how: 'pulled' };
    if (r.activeIsRemote) await d.save({ ...config, activeRemote: remoteUrl, remotes, localFirst: false });
    await d.onFailed(a.id);
    return { ok: false, how: 'failed', reason: r.reason };
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
