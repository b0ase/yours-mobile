/**
 * Pure swipe-row gesture maths (no DOM), so the thresholds are unit tested.
 * dx > 0 = finger moved right (reveals the LEFT-edge tray, "right swipe").
 */
export const AXIS_LOCK_PX = 10;
/** Past this fraction of the row width, releasing commits the full-swipe action. */
export const COMMIT_FRACTION = 0.6;
/** A flick faster than this (px/ms) past the tray commits too. */
export const FLICK_VELOCITY = 0.9;
/** Each tray button's width. */
export const ACTION_W = 72;

export type Axis = 'x' | 'y' | null;

/** Decide the gesture axis once movement passes the lock distance; null while undecided. */
export const lockAxis = (dx: number, dy: number, lock = AXIS_LOCK_PX): Axis => {
  if (Math.abs(dx) < lock && Math.abs(dy) < lock) return null;
  return Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
};

export type SideSpec = { count: number; hasFull: boolean };
export type Release = 'closed' | 'open-left' | 'open-right' | 'commit-left' | 'commit-right';

/**
 * Where the row rests after release. "left" means a LEFT swipe (dx < 0, tray on the right edge).
 * `start` is the offset the drag began from (an already-open tray), `dx` the total offset now.
 */
export const resolveRelease = (o: {
  offset: number;
  width: number;
  velocity: number;
  left: SideSpec;
  right: SideSpec;
}): Release => {
  const { offset, width, velocity } = o;
  const side = offset < 0 ? o.left : o.right;
  const name = offset < 0 ? 'left' : 'right';
  if (offset === 0 || !side.count) return 'closed';
  const dist = Math.abs(offset);
  const tray = side.count * ACTION_W;
  const sameDir = Math.sign(velocity) === Math.sign(offset);
  if (
    side.hasFull &&
    (dist >= width * COMMIT_FRACTION || (sameDir && Math.abs(velocity) >= FLICK_VELOCITY && dist > tray))
  )
    return `commit-${name}` as Release;
  // Flicking back toward closed closes it.
  if (!sameDir && Math.abs(velocity) >= FLICK_VELOCITY / 2) return 'closed';
  return dist >= tray / 2 ? (`open-${name}` as Release) : 'closed';
};

/** Rubber-banded offset while dragging: free up to the tray (or the commit point), damped beyond. */
export const dragOffset = (raw: number, width: number, left: SideSpec, right: SideSpec): number => {
  const side = raw < 0 ? left : right;
  if (!side.count) return 0;
  const max = side.hasFull ? width : side.count * ACTION_W;
  const d = Math.abs(raw);
  const v = d <= max ? d : max + (d - max) * 0.2;
  return Math.sign(raw) * v;
};

/** True once the drag is far enough that releasing would commit (drives the haptic tick + armed colour). */
export const isArmed = (offset: number, width: number, side: SideSpec) =>
  side.hasFull && Math.abs(offset) >= width * COMMIT_FRACTION;
