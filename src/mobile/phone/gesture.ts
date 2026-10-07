/**
 * Pure gesture maths for the phone layout (tested in gesture.test.ts, in the style of ui/pullMath.ts).
 */

/** A press becomes a long-press only if the finger stays within this many px (so a scroll never triggers it). */
export const LONG_PRESS_SLOP = 8;
export const DOCK_LONG_PRESS_MS = 500;
/** Holding the dock's big b this long opens the b agent page; a shorter press is a tap (HOME). */
export const B_HOLD_MS = 500;
/** A finger that moves more than this while holding the b cancels the hold (and the tap). */
export const B_HOLD_SLOP = 10;

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

/** Page drag (iOS-style paging): the axis locks after this many px. */
export const AXIS_LOCK_PX = 10;
/** Release: go to the neighbour past this share of the width, or on a flick faster than PAGE_FLICK px/ms. */
export const PAGE_COMMIT_SHARE = 0.35;
export const PAGE_FLICK = 0.45;
export const PAGE_SNAP_MS = 280;

/** Rubber band: past an end the page moves a third of the finger, tapering off. */
export const rubberBand = (dx: number, width: number) => {
  const d = Math.abs(dx);
  const c = 0.33;
  return Math.sign(dx) * ((d * c * width) / (width + c * d));
};

/**
 * Where a page drag lands. dx = finger travel (negative = left), vx = release velocity (px/ms).
 * Returns +1 (next page), -1 (previous) or 0 (snap back). Never past an end.
 */
export const pageRelease = (dx: number, vx: number, width: number, hasPrev: boolean, hasNext: boolean): -1 | 0 | 1 => {
  const far = Math.abs(dx) > width * PAGE_COMMIT_SHARE;
  const flick = Math.abs(vx) > PAGE_FLICK && Math.sign(vx) === Math.sign(dx);
  if (!far && !flick) return 0;
  if (dx < 0) return hasNext ? 1 : 0;
  if (dx > 0) return hasPrev ? -1 : 0;
  return 0;
};

/** Axis lock: null until the finger has moved AXIS_LOCK_PX, then 'x' or 'y'. */
export const lockAxis = (dx: number, dy: number): 'x' | 'y' | null =>
  Math.hypot(dx, dy) < AXIS_LOCK_PX ? null : Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';

/** Pull down from the top of an app screen to open the b agent (owner round 6, like iOS Spotlight). */
export const PULL_THRESHOLD = 70;
/** Touches starting this close to the top (status bar, top bar) never pull. */
export const PULL_TOP_ZONE = 100;
/** 0..1 as the finger pulls; 1 = release opens the agent. */
export const pullProgress = (pull: number) => Math.max(0, Math.min(1, pull / PULL_THRESHOLD));
export const pullReached = (pull: number) => pull >= PULL_THRESHOLD;
