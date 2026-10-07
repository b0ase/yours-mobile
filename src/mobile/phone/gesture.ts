/**
 * Pure gesture maths for the phone layout (tested in gesture.test.ts, in the style of ui/pullMath.ts).
 */

/** A press becomes a long-press only if the finger stays within this many px (so a scroll never triggers it). */
export const LONG_PRESS_SLOP = 8;
export const DOCK_LONG_PRESS_MS = 500;

export const longPressCancelled = (dx: number, dy: number, slop = LONG_PRESS_SLOP) => Math.hypot(dx, dy) > slop;

export const SWIPE_MIN_PX = 60;
export const SWIPE_MAX_MS = 600;

/**
 * A page swipe: mostly horizontal (|dx| > 2·|dy|), far enough and quick enough. dir +1 = to the next page
 * (finger moved left), -1 = to the previous page. Null when it is not a page swipe.
 */
export const classifySwipe = (dx: number, dy: number, ms: number): 1 | -1 | null => {
  if (ms > SWIPE_MAX_MS) return null;
  if (Math.abs(dx) < SWIPE_MIN_PX) return null;
  if (Math.abs(dx) <= 2 * Math.abs(dy)) return null;
  return dx < 0 ? 1 : -1;
};

/** Edge fades on a horizontal scroller: shown only on a side with more content beyond it. */
export const edgeFade = (scrollLeft: number, scrollWidth: number, clientWidth: number) => {
  const overflow = scrollWidth - clientWidth > 1;
  return {
    left: overflow && scrollLeft > 1,
    right: overflow && scrollLeft + clientWidth < scrollWidth - 1,
  };
};

/** mask-image for the fades (none when nothing is hidden). */
export const fadeMask = (f: { left: boolean; right: boolean }) =>
  !f.left && !f.right
    ? undefined
    : `linear-gradient(to right, ${f.left ? 'transparent' : '#000'}, #000 ${f.left ? 16 : 0}px, #000 calc(100% - ${f.right ? 24 : 0}px), ${f.right ? 'transparent' : '#000'})`;
