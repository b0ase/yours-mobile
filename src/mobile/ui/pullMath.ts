/** Pull-to-refresh gesture maths (pure, unit-tested). */
export const THRESHOLD = 70;
export const MAX_PULL = 110;
export const DECIDE = 8;

/** Finger travel → indicator travel: 1:1 at first, then ever stiffer (140·d/(140+d), capped). */
export const rubberBand = (dy: number): number => (dy <= 0 ? 0 : Math.min(MAX_PULL, (140 * dy) / (140 + dy)));

/** Release decision: refresh only once the (resisted) pull reaches the threshold. */
export const shouldRefresh = (pull: number): boolean => pull >= THRESHOLD;

/** First decisive move wins: vertical-down pulls, anything else (horizontal, upward) lets go. */
export const gestureIntent = (dx: number, dy: number): 'pull' | 'cancel' | 'undecided' => {
  if (Math.abs(dx) < DECIDE && Math.abs(dy) < DECIDE) return 'undecided';
  return dy > 0 && dy > Math.abs(dx) ? 'pull' : 'cancel';
};

/** Push past the bottom: a short, stiffer stretch that only bounces back (no refresh). */
export const MAX_PUSH = 48;
export const pushBand = (dy: number): number => (dy <= 0 ? 0 : Math.min(MAX_PUSH, (70 * dy) / (140 + dy)));

/** At the bottom, the first decisive move: vertical-up pushes, anything else lets go. */
export const pushIntent = (dx: number, dy: number): 'push' | 'cancel' | 'undecided' => {
  if (Math.abs(dx) < DECIDE && Math.abs(dy) < DECIDE) return 'undecided';
  return dy < 0 && -dy > Math.abs(dx) ? 'push' : 'cancel';
};
