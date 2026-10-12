/**
 * Auto-lock limit. bWalletX stays unlocked by default (chat, Spaces, feed and mail need a live wallet);
 * a deliberate Lock (⌘L, menu, Settings) still locks, and a browser/app restart still clears the session passKey.
 *
 * Stored as settings.lockTimeout in minutes: 0 / null / undefined = Never. The old default of 10 counts as
 * Never too, unless the user picked it in Settings (lockTimeoutChosen).
 */
export const NEVER_LOCK = Number.POSITIVE_INFINITY;
export const MAX_LOCK_TIMEOUT_MINUTES = 1440; // 24 hours
const OLD_DEFAULT_MINUTES = 10;

export type LockSettings = { lockTimeout?: number | null; lockTimeoutChosen?: boolean } | undefined;

/** Minutes the user has chosen, or 0 for Never. */
export const lockTimeoutMinutes = (settings: LockSettings): number => {
  const minutes = settings?.lockTimeout;
  if (!minutes || !Number.isFinite(minutes) || minutes < 1) return 0;
  if (minutes === OLD_DEFAULT_MINUTES && !settings?.lockTimeoutChosen) return 0;
  return Math.min(Math.floor(minutes), MAX_LOCK_TIMEOUT_MINUTES);
};

/** The limit in milliseconds; NEVER_LOCK (Infinity) when the wallet should not auto-lock. */
export const lockTimeoutMs = (settings: LockSettings): number => {
  const minutes = lockTimeoutMinutes(settings);
  return minutes ? minutes * 60 * 1000 : NEVER_LOCK;
};

/**
 * True when the session has run past the limit. A missing lastActiveTime (0 is written on a deliberate lock)
 * always counts as expired, so Never never revives a locked wallet.
 */
export const isSessionExpired = (lastActiveTime: number | undefined | null, limitMs: number, now = Date.now()) => {
  if (!lastActiveTime) return true;
  if (limitMs === NEVER_LOCK) return false;
  return now - Number(lastActiveTime) >= limitMs;
};
