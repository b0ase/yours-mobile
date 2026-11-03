/**
 * Page-side caches that live for one unlocked session of one account (wallet read cache, BAP identity, MNEE scan,
 * sync back-off). A lock clears them all, so nothing from the last session is reused after the next unlock.
 */
const resets = new Set<() => void>();

/** Register a cache's reset; returns an unregister function. */
export const onSessionReset = (fn: () => void): (() => void) => {
  resets.add(fn);
  return () => void resets.delete(fn);
};

/** Clear every registered page-side cache (called when the wallet locks). */
export const resetSessionCaches = () => {
  for (const fn of resets) {
    try {
      fn();
    } catch {
      /* one cache failing to clear must not stop the others */
    }
  }
};

/** A readable line for console logs: the iOS bridge prints Error objects as `{}`. */
export const errText = (err: unknown): unknown => (err instanceof Error ? err.message : err);
