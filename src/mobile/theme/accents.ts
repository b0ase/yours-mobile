/**
 * App accent palette (Theme → App colours, owner 14 Oct 2026). A short curated list, no free picker: each entry is
 * a full accent set that keeps WCAG AA on the black base (accent, hi and lo as text on #010101, and #010101 text
 * on each of them, all at least 4.5:1; accents.test.ts checks). Only the accent changes; the base, the readability
 * and the b logo stay as they are.
 */
export type AccentId = 'gold' | 'silver' | 'rose' | 'emerald' | 'sapphire' | 'violet';

export interface Accent {
  id: AccentId;
  label: string;
  /** Main accent: buttons, active tabs, icons. */
  accent: string;
  /** Lighter stop: gradient tops, bright text, hover. */
  hi: string;
  /** Deeper stop: gradient bottoms. */
  lo: string;
  /** Text on the accent. */
  on: string;
}

export const DEFAULT_ACCENT: AccentId = 'gold';

// Never use upstream's greens (#A1FF8B, #9EFF8A, #34D399) here: vite.brand.ts bcorpColours rewrites them to
// the accent variables at build time, which would make an accent point at itself.
export const ACCENTS: readonly Accent[] = [
  { id: 'gold', label: 'Gold · BSV', accent: '#F5B800', hi: '#FFD24D', lo: '#EAB300', on: '#010101' },
  { id: 'silver', label: 'Silver', accent: '#C3CAD4', hi: '#E6EAF0', lo: '#A7B0BC', on: '#010101' },
  { id: 'rose', label: 'Rose', accent: '#FF7AA2', hi: '#FFA8C2', lo: '#F2588A', on: '#010101' },
  { id: 'emerald', label: 'Emerald', accent: '#3DDC97', hi: '#6EE7B7', lo: '#1FBF83', on: '#010101' },
  { id: 'sapphire', label: 'Sapphire', accent: '#5AA8FF', hi: '#93C6FF', lo: '#3D8EF0', on: '#010101' },
  { id: 'violet', label: 'Violet', accent: '#B197FC', hi: '#D0BFFF', lo: '#9775FA', on: '#010101' },
];

export const accentById = (id: string | null | undefined): Accent =>
  ACCENTS.find((a) => a.id === id) ?? (ACCENTS[0] as Accent);

/** "#F5B800" → "245 184 0", for rgb(var(--bw-accent-rgb) / a). */
export const rgbTriplet = (hex: string): string => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(' ');
};

/** The CSS custom properties for one accent (src/accent.css holds the gold defaults). */
export const accentVars = (a: Accent): Record<string, string> => ({
  '--bw-accent': a.accent,
  '--bw-accent-hi': a.hi,
  '--bw-accent-lo': a.lo,
  '--bw-accent-rgb': rgbTriplet(a.accent),
  '--bw-accent-hi-rgb': rgbTriplet(a.hi),
  '--bw-accent-lo-rgb': rgbTriplet(a.lo),
  '--bw-on-accent': a.on,
});

/** WCAG relative-luminance contrast ratio between two #rrggbb colours. */
export const contrast = (a: string, b: string): number => {
  const lum = (hex: string) => {
    const [r, g, bl] = rgbTriplet(hex)
      .split(' ')
      .map((n) => {
        const c = Number(n) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};
