/**
 * Storage top-ups are never paid without a check (b-Aware report, 12 Nov 2026).
 *
 * When an online store answers HTTP 507 ("storage full"), the @1sat/wallet factory can build and sign a payment to
 * that store by itself, at the price and to the key the store names. Two places do that:
 *
 *  1. The active online store (createAction / signAction / internalizeAction). The factory asks an optional hook,
 *     `onStoragePaymentRequired`, and treats a missing hook as yes. `storagePaymentHook` below is always passed: it
 *     says no unless the payment is to a store and key pinned in this code, at the pinned price, within a small cap
 *     per request and per day, outside a cool-down after the last one, and spending is not paused.
 *  2. A backup store's sync push (processSyncChunk). The factory pays that one out of band, with no hook at all.
 *     `refuseBackupStorageAutoPay` patches the StorageClient class so a 507 from a backup is reported as "storage
 *     full" and never starts that payment.
 *
 * No storage price or store key is pinned today (pricing comes from the store itself), so every automatic top-up is
 * refused and the owner is told once per cool-down. Nothing here pays anything.
 */
import type { StoragePaymentHook, StoragePaymentRequiredInfo } from '@1sat/wallet';
import { isPaused } from '../mobile/config/killSwitch';

/** A store whose price we know. The payment is derived to `serverIdentityKey` (BRC-29), so it is the destination. */
export type KnownStoragePrice = {
  /** The store's origin, e.g. https://storage.example (no path). */
  origin: string;
  serverIdentityKey: string;
  purchaseUnitBytes: number;
  satsPerUnit: number;
};

/**
 * Stores and prices pinned in this code. A server can't add to this list. Empty: no price or key is pinned, so every
 * automatic storage payment is refused.
 */
export const KNOWN_STORAGE_PRICES: readonly KnownStoragePrice[] = [];

/** The most one automatic storage payment may be. */
export const STORAGE_PAY_MAX_PER_REQUEST_SATS = 10_000;
/** The most automatic storage payments may add up to in any 24 hours. */
export const STORAGE_PAY_MAX_PER_DAY_SATS = 20_000;
/** After one is approved, no other for this long, whatever the store answers. */
export const STORAGE_PAY_COOLDOWN_MS = 10 * 60_000;
const DAY_MS = 24 * 3_600_000;

export const STORAGE_PAY_REFUSED_NOTICE =
  'Your online storage is full and asked for a payment. bWalletX did not pay it. Nothing was paid. ' +
  'Switch to This device in Settings › Storage to keep going.';

export const BACKUP_FULL_NOTICE =
  'Your online backup is full. bWalletX did not pay for more space. Nothing was paid. ' +
  'Your wallet on this device keeps working.';

export type StoragePayDecision = { ok: true } | { ok: false; reason: string };

/** Approved payments and the last approval, shared by every wallet this process opens (an account switch included). */
export type StoragePayLedger = { lastApprovedAt: number; spends: { at: number; sats: number }[]; lastNoticeAt: number };
export const createStoragePayLedger = (): StoragePayLedger => ({
  lastApprovedAt: -Infinity,
  spends: [],
  lastNoticeAt: -Infinity,
});
const processLedger = createStoragePayLedger();

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

const posInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

/** Pure: may this storage payment go through without a sheet? Never pays; the caller records an approval. */
export function decideStoragePayment(
  info: StoragePaymentRequiredInfo,
  ctx: { known: readonly KnownStoragePrice[]; ledger: StoragePayLedger; now: number },
): StoragePayDecision {
  const { known, ledger, now } = ctx;
  if (now - ledger.lastApprovedAt < STORAGE_PAY_COOLDOWN_MS)
    return { ok: false, reason: 'a storage payment was made a moment ago' };
  const p = info?.pricing;
  if (
    !posInt(info?.satsRequired) ||
    !posInt(info?.deficitBytes) ||
    !posInt(p?.purchaseUnitBytes) ||
    !posInt(p?.satsPerUnit)
  )
    return { ok: false, reason: 'the storage sent a price we can not read' };
  const origin = originOf(info.remoteUrl);
  const pinned = known.find((k) => k.origin === origin);
  if (!pinned) return { ok: false, reason: 'no storage price is known for this store' };
  if (info.serverIdentityKey !== pinned.serverIdentityKey)
    return { ok: false, reason: 'the payment would go to a key that is not this store’s' };
  if (p.purchaseUnitBytes !== pinned.purchaseUnitBytes || p.satsPerUnit !== pinned.satsPerUnit)
    return { ok: false, reason: 'the store’s price is not the known price' };
  if (info.satsRequired !== Math.ceil(info.deficitBytes / p.purchaseUnitBytes) * p.satsPerUnit)
    return { ok: false, reason: 'the amount does not match the price' };
  if (info.satsRequired > STORAGE_PAY_MAX_PER_REQUEST_SATS) return { ok: false, reason: 'the amount is over the cap' };
  const today = ledger.spends.filter((s) => now - s.at < DAY_MS).reduce((t, s) => t + s.sats, 0);
  if (today + info.satsRequired > STORAGE_PAY_MAX_PER_DAY_SATS)
    return { ok: false, reason: 'storage payments today are at the cap' };
  return { ok: true };
}

export type StoragePaymentHookDeps = {
  known?: readonly KnownStoragePrice[];
  /** True while spending is paused (the kill switch). A failure to read it counts as paused. */
  paused?: () => Promise<boolean>;
  /** One line for the owner, at most once per cool-down. */
  notice?: (text: string) => void;
  now?: () => number;
  ledger?: StoragePayLedger;
  log?: (...a: unknown[]) => void;
};

/** Tell the owner, at most once per cool-down. */
const tell = (ledger: StoragePayLedger, now: number, notice: ((text: string) => void) | undefined, text: string) => {
  if (!notice || now - ledger.lastNoticeAt < STORAGE_PAY_COOLDOWN_MS) return;
  ledger.lastNoticeAt = now;
  try {
    notice(text);
  } catch {
    // a notice never changes the answer
  }
};

/** The hook passed as `onStoragePaymentRequired` on every wallet initWallet creates. Resolves false to refuse. */
export function storagePaymentHook(deps: StoragePaymentHookDeps = {}): StoragePaymentHook {
  const known = deps.known ?? KNOWN_STORAGE_PRICES;
  const ledger = deps.ledger ?? processLedger;
  const now = deps.now ?? Date.now;
  const paused = deps.paused ?? (() => isPaused('spending'));
  const log = deps.log ?? ((...a: unknown[]) => console.warn(...a));
  return async (info) => {
    let isStopped = true;
    try {
      isStopped = await paused();
    } catch {
      isStopped = true;
    }
    // No await from here to the record below: two 507s at once can't both be approved.
    const at = now();
    const d: StoragePayDecision = isStopped
      ? { ok: false, reason: 'spending is paused' }
      : decideStoragePayment(info, { known, ledger, now: at });
    if (!d.ok) {
      log(`[storagePayment] refused a storage payment of ${Number(info?.satsRequired) || 0} sats: ${d.reason}`);
      tell(ledger, at, deps.notice, STORAGE_PAY_REFUSED_NOTICE);
      return false;
    }
    ledger.lastApprovedAt = at;
    ledger.spends.push({ at, sats: info.satsRequired });
    return true;
  };
}

const STORAGE_FULL = /\bnetwork error 507\b/g;
const WRAPPED = Symbol.for('bwx.backupStorageAutoPay.refused');

/**
 * Patch the StorageClient class so a backup's 507 never starts the factory's out-of-band payment: the error still
 * fails that sync push, but reads "storage full (HTTP 507)" instead of the "network error 507" the factory pays on.
 * Must run before any client is made. Returns the undo.
 */
export function refuseBackupStorageAutoPay(
  cls: { prototype: object },
  onFull?: (endpointUrl: string | undefined) => void,
): () => void {
  const proto = cls.prototype as Record<string | symbol, unknown>;
  const original = proto.processSyncChunk as ((...a: unknown[]) => Promise<unknown>) | undefined;
  if (typeof original !== 'function' || proto[WRAPPED]) return () => undefined;
  const hadOwn = Object.prototype.hasOwnProperty.call(proto, 'processSyncChunk');
  const wrapped = async function (this: { endpointUrl?: string }, ...args: unknown[]) {
    try {
      return await original.apply(this, args);
    } catch (e) {
      const msg = (e as { message?: unknown } | null)?.message;
      if (typeof msg !== 'string' || !msg.match(STORAGE_FULL)) throw e;
      const text = msg.replace(STORAGE_FULL, 'storage full (HTTP 507), not paid automatically');
      try {
        onFull?.(this?.endpointUrl);
      } catch {
        // a notice never changes the error
      }
      let rewritten = false;
      try {
        (e as { message: string }).message = text;
        rewritten = (e as { message: string }).message === text;
      } catch {
        // a frozen error: a new one carries it as the cause
      }
      if (rewritten) throw e;
      throw new Error(text, { cause: e });
    }
  };
  proto.processSyncChunk = wrapped;
  proto[WRAPPED] = true;
  return () => {
    if (proto.processSyncChunk === wrapped) {
      if (hadOwn) proto.processSyncChunk = original;
      else delete proto.processSyncChunk;
    }
    delete proto[WRAPPED];
  };
}

/** The owner's one line when a backup store is full, at most once per cool-down (same ledger as the hook). */
export const backupFullNotice =
  (notice?: (text: string) => void, ledger: StoragePayLedger = processLedger, now: () => number = Date.now) =>
  (endpointUrl: string | undefined) => {
    console.warn(`[storagePayment] backup storage ${endpointUrl ?? ''} is full; not paid automatically`);
    tell(ledger, now(), notice, BACKUP_FULL_NOTICE);
  };
