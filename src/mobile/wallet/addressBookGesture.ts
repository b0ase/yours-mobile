/**
 * The address book's swipe gestures (owner, 15 Oct 2026). Pulling the balance carousel right past its first card
 * opens the notebook; swiping the notebook left closes it. Mostly-horizontal drags only, so page scrolls never count.
 */
export const SWIPE_OPEN_PX = 72;

type Drag = { dx: number; dy: number };
const horizontal = ({ dx, dy }: Drag) => Math.abs(dx) > Math.abs(dy) * 1.5;

/** True when a drag on the carousel should open the address book: at the first card, finger moved right far enough. */
export const opensAddressBook = (scrollLeft: number, d: Drag): boolean =>
  scrollLeft <= 1 && d.dx >= SWIPE_OPEN_PX && horizontal(d);

/** True when a drag on the open notebook should close it: a left swipe far enough. */
export const closesAddressBook = (d: Drag): boolean => d.dx <= -SWIPE_OPEN_PX && horizontal(d);
