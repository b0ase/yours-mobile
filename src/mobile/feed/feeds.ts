/**
 * The Feed picker: which feeds exist, which are pinned to the icon row, and the swipe order.
 *
 * The row at the top of Feed is fixed (no scrolling chips): up to MAX_PINNED pinned feeds and an
 * "All feeds" button that opens a grid where the user pins favourites. Pins persist per device.
 * Swiping the feed left / right moves through the row (plus the open feed when it isn't pinned).
 * bMovies is bWalletX only: its entry is behind BMOVIES_FEED_ENABLED so a store build has none of it.
 */
import { BMOVIES_FEED_ENABLED } from '../storeBuild';

export type FeedId = 'following' | 'foryou' | 'bnews' | 'bmovies';

export type FeedDef = { id: FeedId; label: string; hint: string };

const BMOVIES_FEED: FeedDef = { id: 'bmovies', label: 'bMovies', hint: 'Clips from bmovies.app' };

/** Every feed this build has, in the default order. */
export const FEEDS: readonly FeedDef[] = [
  { id: 'following', label: 'Following', hint: 'People you follow' },
  { id: 'foryou', label: 'For you', hint: 'Everything on the feed' },
  { id: 'bnews', label: 'bNews', hint: 'Headlines to discuss' },
  ...(BMOVIES_FEED_ENABLED ? [BMOVIES_FEED] : []),
];

/** Icons in the row besides "All feeds". */
export const MAX_PINNED = 4;

export const isFeedId = (v: unknown, feeds: readonly FeedDef[] = FEEDS): v is FeedId =>
  typeof v === 'string' && feeds.some((f) => f.id === v);

export const feedDef = (id: FeedId, feeds: readonly FeedDef[] = FEEDS): FeedDef =>
  feeds.find((f) => f.id === id) ?? feeds[0];

/** Known, unique ids only, at most MAX_PINNED; the default row when nothing valid is saved. */
export const cleanPins = (raw: unknown, feeds: readonly FeedDef[] = FEEDS): FeedId[] => {
  const list = Array.isArray(raw) ? raw.filter((v, i): v is FeedId => isFeedId(v, feeds) && raw.indexOf(v) === i) : [];
  return (list.length ? list : feeds.map((f) => f.id)).slice(0, MAX_PINNED);
};

/** Pin or unpin a feed. The last pin stays (the row is never empty); a full row drops its oldest pin. */
export const togglePin = (pins: FeedId[], id: FeedId): FeedId[] => {
  if (pins.includes(id)) return pins.length > 1 ? pins.filter((p) => p !== id) : pins;
  return [...pins, id].slice(-MAX_PINNED);
};

/** The swipe order: the pinned row, then the open feed when it was opened from All feeds. */
export const swipeOrder = (pins: FeedId[], current: FeedId): FeedId[] =>
  pins.includes(current) ? pins : [...pins, current];

/** The next (dir 1) or previous (dir -1) feed, or null at either end. */
export const stepFeed = (pins: FeedId[], current: FeedId, dir: 1 | -1): FeedId | null => {
  const order = swipeOrder(pins, current);
  return order[order.indexOf(current) + dir] ?? null;
};

/** Horizontal distance (px) past which a swipe changes feed; a mostly vertical drag never does. */
export const FEED_SWIPE_PX = 70;
export const swipeDir = (dx: number, dy: number, threshold = FEED_SWIPE_PX): 1 | -1 | 0 =>
  Math.abs(dx) >= threshold && Math.abs(dx) > Math.abs(dy) * 1.5 ? (dx < 0 ? 1 : -1) : 0;

// ── persistence (per device) ───────────────────────────────────────────────

export const PINS_KEY = 'bwallet.feed.pins';

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const defaultStore = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

const read = (key: string, store: Store | null): unknown => {
  try {
    return JSON.parse(store?.getItem(key) ?? 'null');
  } catch {
    return null;
  }
};

const write = (key: string, v: unknown, store: Store | null) => {
  try {
    store?.setItem(key, JSON.stringify(v));
  } catch {
    // storage unavailable
  }
};

export const loadPins = (store = defaultStore()): FeedId[] => cleanPins(read(PINS_KEY, store));
export const savePins = (pins: FeedId[], store = defaultStore()) => write(PINS_KEY, pins, store);
