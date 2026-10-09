/**
 * Speaker grid layout (owner-approved spec, 9 Oct 2026). Pure: no React, no LiveKit.
 *
 *   1 = full screen, 2 = stacked, 3–4 = 2×2, 5–9 = 3×3, 10–16 = 4×4,
 *   more than 16 = pages of 4×4 with the active speakers sorted onto the first page.
 *
 * At 4×4 only speakers heard in the last ACTIVE_WINDOW_MS get live video; the rest pause.
 */

export const ACTIVE_WINDOW_MS = 10_000;
export const PAGE_SIZE = 16;

export interface GridShape {
  cols: number;
  rows: number;
  /** Cells on one page. */
  cells: number;
  /** Small tiles: ask the SFU for the low layer. */
  small: boolean;
  /** 4×4 or paged: only recently active speakers get live video. */
  dense: boolean;
}

export const gridShape = (n: number): GridShape => {
  if (n <= 1) return { cols: 1, rows: 1, cells: 1, small: false, dense: false };
  if (n === 2) return { cols: 1, rows: 2, cells: 2, small: false, dense: false };
  if (n <= 4) return { cols: 2, rows: 2, cells: 4, small: false, dense: false };
  if (n <= 9) return { cols: 3, rows: 3, cells: 9, small: true, dense: false };
  return { cols: 4, rows: 4, cells: PAGE_SIZE, small: true, dense: true };
};

/** Free cells on the (last) page that could show "Request to speak". */
export const spareCells = (n: number): number => {
  const s = gridShape(n);
  if (n <= 2) return 0; // full screen and stacked have no spare cell
  const onLast = n % s.cells === 0 ? s.cells : n % s.cells;
  return s.cells - onLast;
};

/**
 * Split speakers into pages. Order is kept (host first, from stageOf) except past 16, where
 * active speakers (speaking now or recently) move onto page one.
 */
export const pagesOf = <T extends { handle: string }>(speakers: T[], active: ReadonlySet<string>): T[][] => {
  if (speakers.length <= PAGE_SIZE) return [speakers];
  const hot = speakers.filter((p) => active.has(p.handle));
  const cold = speakers.filter((p) => !active.has(p.handle));
  const all = [...hot, ...cold];
  const pages: T[][] = [];
  for (let i = 0; i < all.length; i += PAGE_SIZE) pages.push(all.slice(i, i + PAGE_SIZE));
  return pages;
};

/** Handles heard within the window (lastSpoke: handle → ms timestamp). */
export const recentlyActive = (lastSpoke: ReadonlyMap<string, number>, now: number, windowMs = ACTIVE_WINDOW_MS) =>
  new Set([...lastSpoke].filter(([, t]) => now - t <= windowMs).map(([h]) => h));

/**
 * Whether a speaker's camera should be live. Below 4×4 everyone with a camera is live; at 4×4 only
 * the recently active, the expanded tile and me (local preview costs no bandwidth).
 */
export const wantsLiveVideo = (o: {
  handle: string;
  count: number;
  recent: ReadonlySet<string>;
  expanded: string | null;
  me: string;
  onPage: boolean;
}): boolean => {
  if (o.handle === o.me || o.handle === o.expanded) return true;
  if (!o.onPage) return false;
  return !gridShape(o.count).dense || o.recent.has(o.handle);
};
