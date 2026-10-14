/**
 * One bApp icon, drawn for a given pixel size: a black tile, the glyph (or a fallback initial) in the
 * app colour, and the b (the real flag-top b from logo.svg) on its own in the top-right corner, in the
 * same app colour with a light-to-deep gradient and a thin dark outline so it reads over the glyph. No
 * disc or ring. The layout is size-aware: below 64px the b grows (~32% of the tile at 64px, ~43% at
 * 28px), the glyph's strokes thicken, and the glyph shrinks and shifts down-left. Every def id is
 * unique per icon, size and render, so many icons can share one document. 64-unit viewBox.
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
  const h = (0.32 + 0.14 * t) * 64; // the b's height: ~32% of the tile at 64px, ~43% at 28px, 46% at 20px
  const w = h * 0.74; // logo.svg viewBox is 74 × 100
  const inset = 4 - 2 * t;
  const px = 64 / Math.max(size, 1); // viewBox units per screen pixel
  return {
    t,
    // outline: a thin dark edge (about 1px on screen) so the b reads over the glyph, in the b's own units
    badge: { x: 64 - inset - w, y: inset, w, h, outline: 2 * 1.1 * px * (100 / h) },
    glyph: { scale: 1.25 - 0.2 * t, shift: 3.5 * t, stroke: 2 + 0.7 * t },
  };
};

/** Mix a #rrggbb colour toward white (k > 0) or black (k < 0). */
const mix = (hex: string, k: number) => {
  const n = parseInt(hex.slice(1, 7), 16);
  const ch = (v: number) => Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k));
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => ch(v).toString(16).padStart(2, '0')).join('')}`;
};

/** Relative luminance 0–1, to lift dark colours so the b still reads on black. */
const luma = (hex: string) => {
  const n = parseInt(hex.slice(1, 7), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
};

/** The badge colours for an app colour: a light-to-deep gradient for the b. */
export const badgeColors = (color: string) => {
  const c = /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#FFD24D';
  const base = luma(c) < 0.35 ? mix(c, 0.25) : c; // very dark colours get lifted
  return { base, top: mix(base, 0.4), mid: base, bottom: mix(base, -0.15) };
};

let seq = 0;

/** The b on its own (no disc), top-right, in the app colour with a thin dark outline. `id` keeps defs unique. */
const badge = (size: number, color: string, id: string) => {
  const k = badgeColors(color);
  const { badge: b } = layout(size);
  const o = r(b.outline);
  const shapes = '<polygon points="45,12 45,76 27,76 27,30"/><circle cx="60" cy="72" r="33"/>';
  return (
    `<svg x="${r(b.x)}" y="${r(b.y)}" width="${r(b.w)}" height="${r(b.h)}" viewBox="23 8 74 100" overflow="visible">` +
    `<defs><linearGradient id="${id}-g" gradientUnits="userSpaceOnUse" x1="0" y1="12" x2="0" y2="105"><stop offset="0" stop-color="${k.top}"/><stop offset=".55" stop-color="${k.mid}"/><stop offset="1" stop-color="${k.bottom}"/></linearGradient>` +
    `<mask id="${id}-m" maskUnits="userSpaceOnUse" x="0" y="0" width="140" height="140"><rect width="140" height="140" fill="#fff"/><circle cx="60" cy="72" r="15" fill="#000"/></mask>` +
    `<mask id="${id}-o" maskUnits="userSpaceOnUse" x="0" y="0" width="140" height="140"><rect width="140" height="140" fill="#fff"/><circle cx="60" cy="72" r="${r(Math.max(15 - b.outline / 2, 4))}" fill="#000"/></mask></defs>` +
    `<g fill="#0B0B0D" stroke="#0B0B0D" stroke-width="${o}" stroke-linejoin="round" mask="url(#${id}-o)">${shapes}</g>` +
    `<g fill="url(#${id}-g)" mask="url(#${id}-m)">${shapes}</g></svg>`
  );
};

/** The icon as SVG markup at a pixel size. */
export const iconSvg = (content: IconContent, size = 64, label = '') => {
  const id = `bb-${'glyph' in content ? content.glyph : 'l'}-${size}-${++seq}`;
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
    badge(size, content.color, id) +
    '</svg>'
  );
};

/** The icon as a data: URL, for anything that takes an image src. */
export const iconDataUrl = (content: IconContent, size = 64, label = '') =>
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(iconSvg(content, size, label))}`;
