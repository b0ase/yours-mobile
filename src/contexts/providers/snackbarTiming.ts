import type { SnackbarType } from '../SnackbarContext';

/**
 * Errors used to vanish after 3 s, too fast to read or select (owner, 10 Oct 2026: "I couldn't copy the
 * error"). Errors now stay at least 8 s, and stay up while the pointer is over them.
 */
export const ERROR_MIN_MS = 8000;

export const snackbarDuration = (type: SnackbarType, requested: number | undefined, fallback: number): number => {
  const ms = requested || fallback;
  return type === 'error' ? Math.max(ms, ERROR_MIN_MS) : ms;
};
