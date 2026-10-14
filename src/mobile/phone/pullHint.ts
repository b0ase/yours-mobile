/**
 * "Pull down to ask b" is invisible until you know it (owner, 14 Oct 2026). The shell shows a short hint, a
 * few app opens in a row, until the person has pulled once. Pure; the shell owns the storage and timers.
 */
export const PULL_HINT_KEY = 'bwallet.phone.pullHint';
export const PULL_HINT_SHOWS = 3;
export const PULL_HINT_DELAY_MS = 1600;
export const PULL_HINT_TEXT = 'Pull down from the top to ask b';

/** stored = '' (never shown), '1'..'n' (shown n times) or 'done' (pulled once). */
export const nextPullHint = (stored: string | null | undefined): { show: boolean; next: string } => {
  if (stored === 'done') return { show: false, next: 'done' };
  const n = Number(stored) || 0;
  if (n >= PULL_HINT_SHOWS) return { show: false, next: String(n) };
  return { show: true, next: String(n + 1) };
};
