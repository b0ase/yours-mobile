/** Slug → icon content / SVG / data URL. */
import { BAPP_ICONS, bappIconDef, initialOf } from './registry';
import { iconDataUrl, iconSvg, type IconContent } from './render';

/** What to draw for a slug: its glyph, or the fallback initial (of `label`, else the slug) in `color`. */
export const bappIconContent = (slug: string, fallback: { label?: string; color?: string } = {}): IconContent => {
  const d = bappIconDef(slug);
  if (d) return { glyph: d.slug, color: d.color };
  return { letter: initialOf(fallback.label ?? slug), color: fallback.color ?? '#FFD24D' };
};

/** A data: URL for the slug's icon at a pixel size. */
export const bappIconUrl = (slug: string, size = 64, fallback?: { label?: string; color?: string }) =>
  iconDataUrl(bappIconContent(slug, fallback), size, bappIconDef(slug)?.label ?? fallback?.label ?? '');

export const bappIconSvg = (slug: string, size = 64, fallback?: { label?: string; color?: string }) =>
  iconSvg(bappIconContent(slug, fallback), size, bappIconDef(slug)?.label ?? fallback?.label ?? '');

export const ALL_BAPP_ICON_SLUGS = Object.keys(BAPP_ICONS);
