/**
 * Feed picker icons. $b* feeds use the bApp icon set (brand/bappIcons: glyph + gold b badge, or the
 * set's initial fallback); ventures keep their own art or initial;
 * the built-in feeds (Following, For you) and "All feeds" use line glyphs; a bApp with no art yet gets
 * its initial on its own colour.
 */
import tokenblasterIcon from '../brand/apps/tokenblaster.png';
import b3dIcon from '../brand/apps/b3d.png';
import bartIcon from '../brand/apps/bart.png';
import bbooksIcon from '../brand/apps/bbooks.png';
import bcalIcon from '../brand/apps/bcal.png';
import bcodeIcon from '../brand/apps/bcode.png';
import beduIcon from '../brand/apps/bedu.png';
import bexchangeIcon from '../brand/apps/bexchange.png';
import bgamesIcon from '../brand/apps/bgames.png';
import bjobsIcon from '../brand/apps/bjobs.png';
import bmapsIcon from '../brand/apps/bmaps.png';
import bmoviesIcon from '../brand/apps/bmovies.png';
import bnewsIcon from '../brand/apps/bnews.svg';
import bpaintIcon from '../brand/apps/bpaint.png';
import bsheetsIcon from '../brand/apps/bsheets.png';
import bsocialIcon from '../brand/apps/bsocial.png';
import bwriterIcon from '../brand/apps/bwriter.png';
import { BEX_REEL_ENABLED, BMOVIES_FEED_ENABLED, TOKENBLASTER_ENABLED } from '../storeBuild';
import { SOURCE_REGISTRY } from './sources';
import { bappIconDef } from '../brand/bappIcons';
import { feedDef, isFeedId, type FeedId } from './feeds';

export type FeedGlyph = 'home' | 'foryou' | 'all';
export type FeedIcon =
  | { kind: 'app'; src: string }
  | { kind: 'bapp'; slug: string; label: string }
  | { kind: 'glyph'; glyph: FeedGlyph }
  | { kind: 'letter'; letter: string };

/** Ventures keep their own art; $b* apps use the bApp icon set (brand/bappIcons). */
// TokenBlaster's icon ships only where its feed does (TOKENBLASTER_ENABLED; store bundle carries neither).
// Owner, 9 Nov 2026: real logos wherever we have one; bMovies' and bExchange's likewise ship only with their feeds.
const APP_ICONS: Partial<Record<FeedId, string>> = {
  ...(TOKENBLASTER_ENABLED ? { tokenblaster: tokenblasterIcon } : {}),
  ...(BMOVIES_FEED_ENABLED ? { bmovies: bmoviesIcon } : {}),
  ...(BEX_REEL_ENABLED ? { bexchange: bexchangeIcon } : {}),
  b3d: b3dIcon,
  bart: bartIcon,
  bbooks: bbooksIcon,
  bcal: bcalIcon,
  bedu: beduIcon,
  bgame: bgamesIcon,
  bitcoincode: bcodeIcon,
  bjobs: bjobsIcon,
  bmaps: bmapsIcon,
  bnews: bnewsIcon,
  bpaint: bpaintIcon,
  bsheets: bsheetsIcon,
  bsocial: bsocialIcon,
  writer: bwriterIcon,
  'src-bchat': SOURCE_REGISTRY.bchat.icon,
  'src-twetch': SOURCE_REGISTRY.twetch.icon,
  'src-treechat': SOURCE_REGISTRY.treechat.icon,
  'src-peck': SOURCE_REGISTRY.peck.icon,
  'src-fwetch': SOURCE_REGISTRY.fwetch.icon,
  'src-coingeek': SOURCE_REGISTRY.coingeek.icon,
  'src-hodlocker': SOURCE_REGISTRY.hodlocker.icon,
  'src-relayx': SOURCE_REGISTRY.relayx.icon,
};

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
