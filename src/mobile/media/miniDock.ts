/**
 * Where the mini player sits: directly above the bottom nav (tab bar, phone dock or bApp bar), never over it.
 * Measured from the nav's own box, so its real height and the home-indicator inset are both included.
 */
type Box = { top: number; bottom: number; height: number; width: number };

/** Until a nav is measured: the dock height plus the home indicator, plus a small gap. */
export const MINI_FALLBACK_BOTTOM = 'calc(var(--dock-h, 3.75rem) + env(safe-area-inset-bottom, 0px) + 0.5rem)';
const GAP = 8;

/**
 * Pixels from the bottom of the mini player's container to its bottom edge: above the highest visible nav inside
 * that container, plus a small gap. null when there is no visible nav (wide layout) or nothing to measure.
 */
export function dockBottom(container: Box | null, navs: Box[]): number | null {
  if (!container) return null;
  const tops = navs
    .filter((n) => n.height > 0 && n.width > 0 && n.bottom > container.top && n.top < container.bottom)
    .map((n) => n.top);
  if (!tops.length) return null;
  return Math.max(0, Math.ceil(container.bottom - Math.min(...tops))) + GAP;
}
