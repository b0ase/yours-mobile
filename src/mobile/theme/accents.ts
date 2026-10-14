/**
 * App themes (Theme → App colours). Owner, 14 Oct 2026: first a short accent list, then "a bit lame", so the top row
 * is now four full THEMES (Classic, Executive, Cyberpunk, Pastel), each a complete look made of CSS variables plus
 * a theme id on <html data-bw-theme>: accent, page and surface colours, trim, glow, type for numbers and headings,
 * and the card pattern it suggests. The plain accents stay under "More colours". No forked components: every screen
 * reads the same variables. Each entry keeps WCAG AA (accents.test.ts): accent/hi/lo and white text on its page
 * colour, and its on-accent text on accent/hi/lo, all at least 4.5:1.
 */
export type AccentId =
  | 'gold'
  | 'executive'
  | 'cyber'
  | 'pastel'
  | 'silver'
  | 'rose'
  | 'emerald'
  | 'sapphire'
  | 'violet';

export type CardPatternId =
  | 'topo'
  | 'guilloche'
  | 'cypher'
  | 'clouds'
  | 'waves'
  | 'hex'
  | 'stripes'
  | 'halftone'
  | 'circuit'
  | 'chevron'
  | 'starburst';

export interface Accent {
  id: AccentId;
  label: string;
  /** 'theme' = a full look (top row); 'colour' = accent only (More colours). */
  kind: 'theme' | 'colour';
  /** One line under the theme's name. */
  blurb?: string;
  /** Main accent: buttons, active tabs, icons. */
  accent: string;
  /** Lighter stop: gradient tops, bright text, hover. */
  hi: string;
  /** Deeper stop: gradient bottoms. */
  lo: string;
  /** Text on the accent. */
  on: string;
  /** Page background. */
  bg: string;
  /** Raised surfaces: sheets, rows, inputs. */
  surface: string;
  /** Border on cards and buttons ('transparent' = none). */
  trim: string;
  /** Extra glow on accent buttons ('none' = none). */
  glow: string;
  /** Font for amounts and labels. */
  fontNum: string;
  /** Font for headings. */
  fontHead: string;
  /** Corner radius of buttons. */
  radius: string;
  /** The card pattern this theme suggests (Design your card › Patterns). */
  pattern: CardPatternId;
}

export const DEFAULT_ACCENT: AccentId = 'gold';

const SANS = 'inherit';
const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
const SERIF = "'Cormorant Garamond', 'Iowan Old Style', Georgia, 'Times New Roman', serif";
const BASE = {
  bg: '#010101',
  surface: '#17191E',
  trim: 'transparent',
  glow: 'none',
  fontNum: SANS,
  fontHead: SANS,
  radius: '12px',
  pattern: 'topo' as CardPatternId,
  kind: 'colour' as const,
  on: '#010101',
};

// Never use upstream's greens (#A1FF8B, #9EFF8A, #34D399) here: vite.brand.ts bcorpColours rewrites them to
// the accent variables at build time, which would make an accent point at itself.
export const ACCENTS: readonly Accent[] = [
  {
    ...BASE,
    id: 'gold',
    kind: 'theme',
    label: 'Classic',
    blurb: 'Gold on black',
    accent: '#F5B800',
    hi: '#FFD24D',
    lo: '#EAB300',
  },
  {
    ...BASE,
    id: 'executive',
    kind: 'theme',
    label: 'Executive',
    blurb: 'Gloss black, gold trim',
    accent: '#D9B45A',
    hi: '#F0D58C',
    lo: '#C9A24A',
    bg: '#050506',
    surface: '#111114',
    trim: 'rgb(217 180 90 / 0.55)',
    fontHead: SERIF,
    radius: '6px',
    pattern: 'guilloche',
  },
  {
    ...BASE,
    id: 'cyber',
    kind: 'theme',
    label: 'Cyberpunk',
    blurb: 'Matrix green, cyphertext',
    accent: '#00FF66',
    hi: '#7DFFA8',
    lo: '#00D957',
    bg: '#020604',
    surface: '#08140D',
    trim: 'rgb(0 255 102 / 0.45)',
    glow: '0 0 12px rgb(0 255 102 / 0.45)',
    fontNum: MONO,
    fontHead: MONO,
    radius: '4px',
    pattern: 'cypher',
  },
  {
    ...BASE,
    id: 'pastel',
    kind: 'theme',
    label: 'Pastel',
    blurb: 'Mint, baby blue, blush',
    accent: '#9FD8FF',
    hi: '#FFD1E3',
    lo: '#A8EBCF',
    on: '#1E1A33',
    bg: '#1E1A33',
    surface: '#2B2647',
    trim: 'rgb(255 209 227 / 0.35)',
    radius: '999px',
    pattern: 'clouds',
  },
  { ...BASE, id: 'silver', label: 'Silver', accent: '#C3CAD4', hi: '#E6EAF0', lo: '#A7B0BC' },
  { ...BASE, id: 'rose', label: 'Rose', accent: '#FF7AA2', hi: '#FFA8C2', lo: '#F2588A' },
  { ...BASE, id: 'emerald', label: 'Emerald', accent: '#3DDC97', hi: '#6EE7B7', lo: '#1FBF83' },
  { ...BASE, id: 'sapphire', label: 'Blue', accent: '#5AA8FF', hi: '#93C6FF', lo: '#3D8EF0' },
  { ...BASE, id: 'violet', label: 'Purple', accent: '#B197FC', hi: '#D0BFFF', lo: '#9775FA' },
];

export const THEMES = ACCENTS.filter((a) => a.kind === 'theme');
export const MORE_COLOURS = ACCENTS.filter((a) => a.kind === 'colour');

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
  '--bw-bg': a.bg,
  '--bw-surface': a.surface,
  '--bw-trim': a.trim,
  '--bw-glow': a.glow,
  '--bw-font-num': a.fontNum,
  '--bw-font-head': a.fontHead,
  '--bw-radius-btn': a.radius,
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
