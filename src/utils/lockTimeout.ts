/**
 * Auto-lock limit. bWalletX stays unlocked by default (chat, Spaces, feed and mail need a live wallet);
 * a deliberate Lock (⌘L, menu, Settings) still locks, and a browser/app restart still clears the session passKey.
 *
 * Stored as settings.lockTimeout in minutes: 0 / null / undefined = Never. Any stored positive value is the
 * user's own choice and is kept: before the Never default (2d291034) lockTimeout was only ever written when the
 * user saved it in Settings (unset fell back to 10 in code), so a stored 10 is an explicit choice too
 * (security review M2). lockTimeoutChosen is still written by Settings but no longer needed to honour 10.
 */
export const NEVER_LOCK = Number.POSITIVE_INFINITY;
export const MAX_LOCK_TIMEOUT_MINUTES = 1440; // 24 hours

export type LockSettings = { lockTimeout?: number | null; lockTimeoutChosen?: boolean } | undefined;

/** Minutes the user has chosen, or 0 for Never. */
export const lockTimeoutMinutes = (settings: LockSettings): number => {
  const minutes = settings?.lockTimeout;
  if (!minutes || !Number.isFinite(minutes) || minutes < 1) return 0;
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
