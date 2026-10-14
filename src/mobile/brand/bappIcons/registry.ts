/**
 * The bApp icon registry: slug → glyph + colour. Colours come from FEED_COLORS (feeds.ts), so a bApp's
 * icon, chip ring and selected state always match. A slug with no glyph yet gets the fallback (its
 * initial in the app colour), so the set can grow without new art.
 */
import { FEED_COLORS, GOLD } from '../../feed/feeds';
import { PLACEMENT_ENABLED } from '../../storeBuild';
import { GLYPHS, type GlyphSlug } from './glyphs';

export type BappIconDef = { slug: GlyphSlug; label: string; color: string };

const def = (slug: GlyphSlug, label: string, color: string | undefined): BappIconDef => ({
  slug,
  label,
  color: color ?? GOLD,
});

export const BAPP_ICONS: Record<GlyphSlug, BappIconDef> = {
  bmovies: def('bmovies', 'bMovies', FEED_COLORS.bmovies),
  bmusic: def('bmusic', 'bMusic', FEED_COLORS.bmusic),
  bnews: def('bnews', 'bNews', FEED_COLORS.bnews),
  bradio: def('bradio', 'bRadio', FEED_COLORS.bradio),
  bgames: def('bgames', 'bGames', FEED_COLORS.bgame),
  bart: def('bart', 'bArt', '#E93D82'),
  bpaint: def('bpaint', 'bPaint', FEED_COLORS.bpaint),
  bjobs: def('bjobs', 'bJobs', FEED_COLORS.bjobs),
  bdrive: def('bdrive', 'bDrive', FEED_COLORS.bdrive),
  bsheets: def('bsheets', 'bSheets', FEED_COLORS.bsheets),
  bcal: def('bcal', 'bCal', FEED_COLORS.bcal),
  bcode: def('bcode', 'bCode', FEED_COLORS.bitcoincode),
  bagents: def('bagents', 'bAgents', FEED_COLORS.bidentity),
  b3d: def('b3d', 'b3D', FEED_COLORS.b3d),
  bphotos: def('bphotos', 'bPhotos', FEED_COLORS.bphotos),
  bbooks: def('bbooks', 'bBooks', FEED_COLORS.bbooks),
  bwriter: def('bwriter', 'bWriter', FEED_COLORS.writer),
  bmail: def('bmail', 'bMail', FEED_COLORS.bmail),
  bsocial: def('bsocial', 'bSocial', FEED_COLORS.bsocial),
  bchatx: def('bchatx', 'bChatX', FEED_COLORS.bbrowser),
  bexchange: def('bexchange', 'bExchange', FEED_COLORS.bexchange),
  bcredits: def('bcredits', 'bCredits', FEED_COLORS.bmarket),
  // bShares is bWalletX only (PLACEMENT_ENABLED): the store bundle never carries its name.
  bshares: def('bshares', PLACEMENT_ENABLED ? 'bShares' : '', FEED_COLORS.bdns),
};

/** Other names for the same bApp (feed ids, shelf ids) → glyph slug. */
const ALIASES: Record<string, GlyphSlug> = {
  bgame: 'bgames',
  writer: 'bwriter',
  bchat: 'bchatx',
  credits: 'bcredits',
  shares: 'bshares',
  bitcoincode: 'bcode',
};

export const hasGlyph = (slug: string): slug is GlyphSlug => Object.hasOwn(GLYPHS, slug);

/** The registered icon for a slug or alias, or null (use the fallback). */
export const bappIconDef = (slug: string): BappIconDef | null => {
  const s = slug.toLowerCase();
  const key = hasGlyph(s) ? s : ALIASES[s];
  return key ? BAPP_ICONS[key] : null;
};

/** The first letter after a leading b / $ ("bRadio" → "R", "$402" → "4"), upper-cased. */
export const initialOf = (label: string) => (label.replace(/^\$|^b(?=[A-Z0-9])/, '')[0] ?? '?').toUpperCase();
