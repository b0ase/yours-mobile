/**
 * Feed picker icons. bApp feeds use that bApp's own icon (the same art as the bApps shelf, brand/apps);
 * the built-in feeds (Following, For you) and "All feeds" use gold line glyphs drawn on the same
 * black tile. bMovies' icon is bWalletX only, like its feed (BMOVIES_FEED_ENABLED), so a store build
 * carries none of it.
 */
import bmoviesIcon from '../brand/apps/bmovies.png';
import bnewsIcon from '../brand/apps/bnews.svg';
import { BMOVIES_FEED_ENABLED } from '../storeBuild';
import type { FeedId } from './feeds';

export type FeedGlyph = 'following' | 'foryou' | 'all';
export type FeedIcon = { kind: 'app'; src: string } | { kind: 'glyph'; glyph: FeedGlyph };

const APP_ICONS: Partial<Record<FeedId, string>> = {
  bnews: bnewsIcon,
  ...(BMOVIES_FEED_ENABLED ? { bmovies: bmoviesIcon } : {}),
};

const GLYPHS: Partial<Record<FeedId, FeedGlyph>> = { following: 'following', foryou: 'foryou' };

/** The icon for a feed: its bApp's art, else a glyph (an unknown feed gets For you's). */
export const feedIcon = (id: FeedId): FeedIcon => {
  const src = APP_ICONS[id];
  if (src) return { kind: 'app', src };
  return { kind: 'glyph', glyph: GLYPHS[id] ?? 'foryou' };
};

export const ALL_FEEDS_ICON: FeedIcon = { kind: 'glyph', glyph: 'all' };
