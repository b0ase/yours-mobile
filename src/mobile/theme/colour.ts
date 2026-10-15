/**
 * Small colour toolkit for theme packs and the colour mixer (Theme → App colours). Pure functions, #rrggbb in and
 * out, so packs, the mixer and the card art all speak the same format and tests can check every value.
 */
export type Hsl = { h: number; s: number; l: number };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const rgbToHex = (r: number, g: number, b: number): string =>
  '#' +
  [r, g, b]
    .map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

/** "#F5B800" → "245 184 0", for rgb(var(--x-rgb) / a). */
export const rgbTriplet = (hex: string): string => hexToRgb(hex).join(' ');

export function hexToHsl(hex: string): Hsl {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: s * 100, l: l * 100 };
}

export function hslToHex({ h, s, l }: Hsl): string {
  const S = clamp(s, 0, 100) / 100;
  const L = clamp(l, 0, 100) / 100;
  const k = (n: number) => (n + (((h % 360) + 360) % 360) / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return rgbToHex(f(0) * 255, f(8) * 255, f(4) * 255);
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colours (1–21). */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** Linear mix: t = 0 gives a, t = 1 gives b. */
export function mix(a: string, b: string, t: number): string {
  const p = hexToRgb(a);
  const q = hexToRgb(b);
  return rgbToHex(...(p.map((v, i) => v + ((q[i] as number) - v) * t) as [number, number, number]));
}

/**
 * Nudges `fg`'s lightness (keeping hue and saturation) until it reaches `ratio` against every colour in `bgs`.
 * Moves away from the backgrounds: lighter on dark grounds, darker on light ones; if that runs out of room it
 * tries the other way. Falls back to black or white, whichever reads better, so the result always passes.
 */
export function ensureContrast(fg: string, bgs: string | string[], ratio = 4.5): string {
  const list = Array.isArray(bgs) ? bgs : [bgs];
  const ok = (c: string) => list.every((bg) => contrast(c, bg) >= ratio);
  if (ok(fg)) return fg.toUpperCase();
  const base = hexToHsl(fg);
  const darkGround = list.reduce((s, bg) => s + luminance(bg), 0) / list.length < 0.18;
  for (const dir of darkGround ? [1, -1] : [-1, 1]) {
    for (let step = 1; step <= 100; step++) {
      const l = base.l + dir * step;
      if (l < 0 || l > 100) break;
      const c = hslToHex({ ...base, l });
      if (ok(c)) return c;
    }
  }
  const best = ['#FFFFFF', '#000000'].find(ok);
  return best ?? (darkGround ? '#FFFFFF' : '#000000');
}

/** The first candidate that reaches `ratio` on every background, else the best-reading of black and white. */
export function pickReadable(candidates: string[], bgs: string[], ratio = 4.5): string {
  const found = candidates.find((c) => bgs.every((bg) => contrast(c, bg) >= ratio));
  if (found) return found.toUpperCase();
  const score = (c: string) => Math.min(...bgs.map((bg) => contrast(c, bg)));
  return score('#000000') >= score('#FFFFFF') ? '#000000' : '#FFFFFF';
}
