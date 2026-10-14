/**
 * One bApp icon, drawn for a given pixel size: a black tile, the glyph (or a fallback initial) in the
 * app colour, and the gold b badge (the real flag-top b from logo.svg) on a black disc with a thin gold
 * ring, overlapping the top-right corner. The layout is size-aware: below 64px the badge grows (to ~40%
 * of the tile at 28px), its ring and the glyph's strokes thicken, and the glyph shrinks and shifts
 * down-left so both stay readable. Everything is in a 64-unit viewBox.
 */
import { GLYPHS, type GlyphSlug } from './glyphs';

export const ICON_SIZES = [64, 40, 28, 20] as const;

export type IconContent = { glyph: GlyphSlug; color: string } | { letter: string; color: string };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const r = (n: number) => Math.round(n * 100) / 100;
const esc = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The layout numbers for a pixel size (exported for tests). */
export const layout = (size: number) => {
  const t = clamp01((64 - size) / 44); // 0 at 64px+, 1 at 20px and below
  const d = (0.3 + 0.18 * t) * 64; // badge diameter: ~30% of the tile at 64px, ~43% at 28px, 48% at 20px
  const inset = 2.5 - 2 * t;
  const px = 64 / Math.max(size, 1); // viewBox units per screen pixel
  return {
    t,
    badge: { cx: 64 - inset - d / 2, cy: inset + d / 2, d, ring: Math.max(1.4, 0.8 * px) },
    glyph: { scale: 1.25 - 0.2 * t, shift: 3.5 * t, stroke: 1.9 + 0.7 * t },
  };
};

const badge = (size: number) => {
  const { badge: b } = layout(size);
  const h = b.d * (0.62 + 0.1 * layout(size).t); // the b's height inside the disc
  const w = h * 0.74; // logo.svg viewBox is 74 × 100
  return (
    `<circle cx="${r(b.cx)}" cy="${r(b.cy)}" r="${r(b.d / 2 - b.ring / 2)}" fill="#0B0B0D" stroke="#FFD24D" stroke-width="${r(b.ring)}"/>` +
    `<svg x="${r(b.cx - w / 2 + w * 0.03)}" y="${r(b.cy - h / 2)}" width="${r(w)}" height="${r(h)}" viewBox="23 8 74 100">` +
    '<defs><linearGradient id="bg" gradientUnits="userSpaceOnUse" x1="0" y1="12" x2="0" y2="105"><stop offset="0" stop-color="#FFE58A"/><stop offset=".55" stop-color="#FFD24D"/><stop offset="1" stop-color="#E0A800"/></linearGradient>' +
    '<mask id="bh"><rect width="140" height="140" fill="#fff"/><circle cx="60" cy="72" r="15" fill="#000"/></mask></defs>' +
    '<g fill="url(#bg)" mask="url(#bh)"><polygon points="45,12 45,76 27,76 27,30"/><circle cx="60" cy="72" r="33"/></g></svg>'
  );
};

/** The icon as SVG markup at a pixel size. */
export const iconSvg = (content: IconContent, size = 64, label = '') => {
  const { glyph: g } = layout(size);
  const span = 24 * g.scale;
  const x = 32 - span / 2 - g.shift;
  const y = 32 - span / 2 + g.shift;
  const color = esc(content.color);
  const art =
    'glyph' in content
      ? `<g transform="translate(${r(x)} ${r(y)}) scale(${r(g.scale)})" color="${color}" fill="none" stroke="currentColor" stroke-width="${r(g.stroke)}" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[content.glyph]}</g>`
      : `<text x="${r(32 - g.shift)}" y="${r(32 + g.shift)}" dy=".35em" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif" font-size="${r(30 * (g.scale / 1.25))}" font-weight="800" fill="${color}">${esc(content.letter.slice(0, 1))}</text>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" role="img"${label ? ` aria-label="${esc(label)}"` : ''}>` +
    '<rect x=".5" y=".5" width="63" height="63" rx="15" fill="#0B0B0D" stroke="#26272B"/>' +
    art +
    badge(size) +
    '</svg>'
  );
};

/** The icon as a data: URL, for anything that takes an image src. */
export const iconDataUrl = (content: IconContent, size = 64, label = '') =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(iconSvg(content, size, label))}`;
