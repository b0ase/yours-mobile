import { DEFAULT_ACCENT, accentById } from './accents';

/**
 * Accent tint for generated gold art (owner, 14 Oct 2026: a violet theme with gold bAvatars "looks odd").
 * The bAvatar generator stays byte-identical to bit-sign/bChatX (mint, QR and server copies use it untouched);
 * only the picture this device SHOWS is recoloured: every gold-family colour in the SVG takes the accent's hue and
 * saturation, keeping its own lightness, so the art keeps its light and shade. Black, white and greys are left
 * alone, as is anything that is not gold (so a user picture or NFT is never passed through here).
 */
type Hsl = [number, number, number];

function toHsl(r: number, g: number, b: number): Hsl {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function toRgb([h, s, l]: Hsl): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const hh = h / 360;
  return [f(hh + 1 / 3), f(hh), f(hh - 1 / 3)].map((v) => Math.round(v * 255)) as [number, number, number];
}

const hex = (n: number) => n.toString(16).padStart(2, '0');

/** Gold family: warm yellow-orange hues with real colour (the bAvatar palette is hue ~38-48). */
export const isGoldish = ([h, s]: Hsl): boolean => s >= 0.25 && h >= 25 && h <= 62;

/** One #rrggbb colour moved onto the accent, or returned as is when it is not gold. */
export function tintColour(rgb: [number, number, number], accentHex: string): [number, number, number] {
  const c = toHsl(...rgb);
  if (!isGoldish(c)) return rgb;
  const h = accentHex.replace('#', '');
  const [ah, as] = toHsl(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16));
  // Accent saturation, scaled by how saturated this stop was (gold is ~100%), so pale gold stays pale.
  return toRgb([ah, Math.min(1, as * c[1]), c[2]]);
}

/** Recolours an SVG string's gold to the accent. Gold (the default) returns the SVG unchanged. */
export function tintSvg(svg: string, accentId: string | null | undefined): string {
  const a = accentById(accentId);
  if (a.id === DEFAULT_ACCENT) return svg;
  return svg
    .replace(/#([0-9a-f]{6})\b/gi, (m, v: string) => {
      const n = parseInt(v, 16);
      const out = tintColour([n >> 16, (n >> 8) & 255, n & 255], a.accent);
      return '#' + out.map(hex).join('');
    })
    .replace(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/gi, (m, r: string, g: string, b: string) => {
      const out = tintColour([+r, +g, +b], a.accent);
      return m.slice(0, m.indexOf('(') + 1) + out.join(',');
    });
}
