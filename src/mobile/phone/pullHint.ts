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

/**
 * Whether the hint may run at all. Only on an app screen, where the pull works: the shell also wraps onboarding,
 * where the hint covered the "Create New Wallet" button (19 Oct 2026). Only with a touch screen: the pull is a
 * touch gesture, so a mouse can't do it.
 */
export const pullHintApplies = (onAppScreen: boolean, touch: boolean) => onAppScreen && touch;

/** A touch-first screen (phones, tablets); false for a mouse or trackpad. */
export const touchScreen = () => {
  try {
    return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
};
