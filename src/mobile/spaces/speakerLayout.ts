/**
 * Speaker grid layout (owner-approved spec, 9 Oct 2026). Pure: no React, no LiveKit.
 *
 *   1 = one 16:9 TV-shaped tile (full width, never filling the screen height), 2 = two 16:9 tiles
 *   stacked (side by side on wide screens), 3–4 = 2×2, 5–9 = 3×3, 10–16 = 4×4,
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
  /** CSS aspect-ratio of each cell: 16:9 up to 2×2, square from 3×3. Cells never stretch to fill height. */
  aspect: '16 / 9' | '1 / 1';
}

/** Width of a single 16:9 tile: full width, but capped so its height stays under maxVh of the screen. */
export const tvWidth = (maxVh = 55) => `min(100%, ${(maxVh * 16) / 9}vh)`;

export const gridShape = (n: number): GridShape => {
  if (n <= 1) return { cols: 1, rows: 1, cells: 1, small: false, dense: false, aspect: '16 / 9' };
  if (n === 2) return { cols: 1, rows: 2, cells: 2, small: false, dense: false, aspect: '16 / 9' };
  if (n <= 4) return { cols: 2, rows: 2, cells: 4, small: false, dense: false, aspect: '16 / 9' };
  if (n <= 9) return { cols: 3, rows: 3, cells: 9, small: true, dense: false, aspect: '1 / 1' };
  return { cols: 4, rows: 4, cells: PAGE_SIZE, small: true, dense: true, aspect: '1 / 1' };
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
