/**
 * Feed picker icons. bApp feeds use that bApp's own icon (the same art as the bApps shelf, brand/apps);
 * the built-in feeds (Following, For you) and "All feeds" use line glyphs; a bApp with no art yet gets
 * its initial on its own colour. bMovies' icon is bWalletX only, like its feed (BMOVIES_FEED_ENABLED),
 * so a store build carries none of it.
 */
import b3dIcon from '../brand/apps/b3d.png';
import bbooksIcon from '../brand/apps/bbooks.png';
import bcalIcon from '../brand/apps/bcal.png';
import bcodeIcon from '../brand/apps/bcode.png';
import bdriveIcon from '../brand/apps/bdrive.png';
import beduIcon from '../brand/apps/bedu.png';
import bexchangeIcon from '../brand/apps/bexchange.png';
import bgamesIcon from '../brand/apps/bgames.png';
import bjobsIcon from '../brand/apps/bjobs.png';
import bmailIcon from '../brand/apps/bmail.png';
import bmapsIcon from '../brand/apps/bmaps.png';
import bmoviesIcon from '../brand/apps/bmovies.png';
import bnewsIcon from '../brand/apps/bnews.svg';
import bpaintIcon from '../brand/apps/bpaint.png';
import bsheetsIcon from '../brand/apps/bsheets.png';
import bsocialIcon from '../brand/apps/bsocial.png';
import bwriterIcon from '../brand/apps/bwriter.png';
import tokenblasterIcon from '../brand/apps/tokenblaster.png';
import { BMOVIES_FEED_ENABLED } from '../storeBuild';
import { feedDef, isFeedId, type FeedId } from './feeds';

export type FeedGlyph = 'following' | 'foryou' | 'all';
export type FeedIcon =
  | { kind: 'app'; src: string }
  | { kind: 'glyph'; glyph: FeedGlyph }
  | { kind: 'letter'; letter: string };

const APP_ICONS: Partial<Record<FeedId, string>> = {
  b3d: b3dIcon,
  bbooks: bbooksIcon,
  bcal: bcalIcon,
  bitcoincode: bcodeIcon,
  bdrive: bdriveIcon,
  bedu: beduIcon,
  bexchange: bexchangeIcon,
  bgame: bgamesIcon,
  bjobs: bjobsIcon,
  bmail: bmailIcon,
  bmaps: bmapsIcon,
  bnews: bnewsIcon,
  bpaint: bpaintIcon,
  bsheets: bsheetsIcon,
  bsocial: bsocialIcon,
  writer: bwriterIcon,
  tokenblaster: tokenblasterIcon,
  ...(BMOVIES_FEED_ENABLED ? { bmovies: bmoviesIcon } : {}),
};

const GLYPHS: Partial<Record<FeedId, FeedGlyph>> = { following: 'following', foryou: 'foryou' };

/** The first letter after a leading b / $ ("bRadio" → "R", "$402" → "4"), upper-cased. */
const initial = (label: string) => (label.replace(/^\$|^b(?=[A-Z0-9])/, '')[0] ?? '?').toUpperCase();

/** The icon for a feed: its bApp's art, a glyph, or its initial (an unknown feed gets For you's glyph). */
export const feedIcon = (id: FeedId): FeedIcon => {
  const src = APP_ICONS[id];
  if (src) return { kind: 'app', src };
  const glyph = GLYPHS[id];
  if (glyph) return { kind: 'glyph', glyph };
  return isFeedId(id) ? { kind: 'letter', letter: initial(feedDef(id).label) } : { kind: 'glyph', glyph: 'foryou' };
};

export const ALL_FEEDS_ICON: FeedIcon = { kind: 'glyph', glyph: 'all' };
