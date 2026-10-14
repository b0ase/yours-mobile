/**
 * Feed picker icons. $b* feeds use the bApp icon set (brand/bappIcons: glyph + gold b badge, or the
 * set's initial fallback); ventures keep their own art or initial;
 * the built-in feeds (Following, For you) and "All feeds" use line glyphs; a bApp with no art yet gets
 * its initial on its own colour.
 */
import tokenblasterIcon from '../brand/apps/tokenblaster.png';
import { bappIconDef } from '../brand/bappIcons';
import { feedDef, isFeedId, type FeedId } from './feeds';

export type FeedGlyph = 'home' | 'foryou' | 'all';
export type FeedIcon =
  | { kind: 'app'; src: string }
  | { kind: 'bapp'; slug: string; label: string }
  | { kind: 'glyph'; glyph: FeedGlyph }
  | { kind: 'letter'; letter: string };

/** Ventures keep their own art; $b* apps use the bApp icon set (brand/bappIcons). */
const APP_ICONS: Partial<Record<FeedId, string>> = { tokenblaster: tokenblasterIcon };

const GLYPHS: Partial<Record<FeedId, FeedGlyph>> = { home: 'home' };

/** The first letter after a leading b / $ ("bRadio" → "R", "$402" → "4"), upper-cased. */
const initial = (label: string) => (label.replace(/^\$|^b(?=[A-Z0-9])/, '')[0] ?? '?').toUpperCase();

/** The icon for a feed: its bApp's art, a glyph, or its initial (an unknown feed gets For you's glyph). */
export const feedIcon = (id: FeedId): FeedIcon => {
  const src = APP_ICONS[id];
  if (src) return { kind: 'app', src };
  const glyph = GLYPHS[id];
  if (!glyph && isFeedId(id) && (feedDef(id).group === 'bapps' || bappIconDef(id)))
    return { kind: 'bapp', slug: id, label: feedDef(id).label };
  if (glyph) return { kind: 'glyph', glyph };
  return isFeedId(id) ? { kind: 'letter', letter: initial(feedDef(id).label) } : { kind: 'glyph', glyph: 'foryou' };
};

export const ALL_FEEDS_ICON: FeedIcon = { kind: 'glyph', glyph: 'all' };
