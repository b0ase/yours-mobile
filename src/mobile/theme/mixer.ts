import { BASE_LOOK, type Accent, type CardPatternId } from './accents';
import { contrast, ensureContrast, hexToHsl, hslToHex, mix, pickReadable } from './colour';

/**
 * Colour mixer (Theme → App colours › Mix your own, owner 15 Oct 2026): full control with six sliders in two
 * groups plus a light/dark base, and every token derived from those choices with readable contrast guaranteed:
 *
 *   Surfaces         hue · colour (saturation) · depth   → page, cards, fills, nav, body and muted text
 *   Lines & actions  hue · colour (saturation) · brightness → accent stops, buttons, outlines, glow
 *
 * Text, muted text, the accent stops and success/danger are nudged in lightness until each reaches WCAG AA
 * (4.5:1) on the page and both surfaces; on-accent text is picked to reach 4.5:1 on all three accent stops.
 */
export type MixSpec = {
  base: 'dark' | 'light';
  /** Surfaces: hue 0–360, colour 0–100, depth 0–100 (0 = deepest/most neutral, 100 = most lifted). */
  sh: number;
  ss: number;
  sd: number;
  /** Lines & actions: hue 0–360, colour 0–100, brightness 0–100. */
  ah: number;
  as: number;
  al: number;
  /** Optional: corners and pattern carried over from the pack it started from. */
  radius?: string;
  radiusCard?: string;
  pattern?: CardPatternId;
};

export const GOLD_MIX: MixSpec = { base: 'dark', sh: 225, ss: 12, sd: 10, ah: 45, as: 100, al: 48 };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));

/** Cleans a stored or slider spec: unknown keys dropped, numbers clamped. */
export function normaliseMix(m: Partial<MixSpec> | null | undefined): MixSpec {
  const g = GOLD_MIX;
  const v = m ?? {};
  return {
    base: v.base === 'light' ? 'light' : 'dark',
    sh: clamp(v.sh ?? g.sh, 0, 360),
    ss: clamp(v.ss ?? g.ss, 0, 100),
    sd: clamp(v.sd ?? g.sd, 0, 100),
    ah: clamp(v.ah ?? g.ah, 0, 360),
    as: clamp(v.as ?? g.as, 0, 100),
    al: clamp(v.al ?? g.al, 0, 100),
    ...(typeof v.radius === 'string' && /^\d{1,3}px$/.test(v.radius) ? { radius: v.radius } : {}),
    ...(typeof v.radiusCard === 'string' && /^\d{1,3}px$/.test(v.radiusCard) ? { radiusCard: v.radiusCard } : {}),
    ...(typeof v.pattern === 'string' ? { pattern: v.pattern } : {}),
  };
}

/** Builds a complete pack from a mix. Every text/accent token passes AA on page and surfaces. */
export function deriveMix(input: Partial<MixSpec>): Accent {
  const m = normaliseMix(input);
  const dark = m.base === 'dark';
  const sat = m.ss * (dark ? 0.55 : 0.45);
  const d = m.sd / 100;
  // Surfaces: depth lifts the page from near-black (dark) or pulls it down from white (light).
  const bgL = dark ? 2 + d * 10 : 99 - d * 8;
  const step = dark ? 1 : -1;
  const bg = hslToHex({ h: m.sh, s: sat, l: bgL });
  const surface = hslToHex({ h: m.sh, s: sat, l: dark ? bgL + 6 : Math.min(100, bgL + 1.5) });
  const surface2 = hslToHex({ h: m.sh, s: sat, l: dark ? bgL + 10 : bgL - 5 });
  const nav = hslToHex({ h: m.sh, s: sat, l: bgL - step * 1 });
  const grounds = [bg, surface, surface2];
  const text = ensureContrast(hslToHex({ h: m.sh, s: Math.min(sat, 25), l: dark ? 96 : 9 }), grounds, 7);
  const muted = ensureContrast(hslToHex({ h: m.sh, s: Math.min(sat, 20), l: dark ? 66 : 38 }), grounds, 4.5);

  // Lines & actions.
  const aS = m.as;
  const aL = dark ? 40 + m.al * 0.45 : 20 + m.al * 0.35;
  const accent = ensureContrast(hslToHex({ h: m.ah, s: aS, l: aL }), grounds, 4.5);
  const aHsl = hexToHsl(accent);
  const hi = ensureContrast(hslToHex({ ...aHsl, l: aHsl.l + (dark ? 12 : 10) }), grounds, 4.5);
  const lo = ensureContrast(hslToHex({ ...aHsl, l: aHsl.l - (dark ? 6 : 6) }), grounds, 4.5);
  const on = pickReadable([bg, dark ? '#0A0A0A' : '#FFFFFF', dark ? '#FFFFFF' : '#0A0A0A'], [accent, hi, lo]);
  // Outlines take the action hue, quietly; they must still show against the page (3:1 is for focus rings, so
  // hairlines aim for a visible 1.5:1 and never vanish).
  let line = mix(surface, accent, 0.28);
  if (contrast(line, bg) < 1.5) line = mix(surface, text, 0.25);
  const success = ensureContrast(dark ? '#5EE6B0' : '#15803D', grounds, 4.5);
  const danger = ensureContrast(dark ? '#FF8A80' : '#B42318', grounds, 4.5);
  const trimRgb = hexToHsl(accent);
  return {
    ...BASE_LOOK,
    id: 'custom',
    kind: 'custom',
    label: 'Your mix',
    blurb: 'Mixed on this device',
    scheme: m.base,
    accent,
    hi,
    lo,
    on,
    bg,
    surface,
    surface2,
    nav,
    text,
    muted,
    line,
    success,
    danger,
    shadow: dark ? '0 10px 30px rgb(0 0 0 / 0.5)' : '0 8px 24px rgb(0 0 0 / 0.1)',
    trim: `hsl(${Math.round(trimRgb.h)} ${Math.round(trimRgb.s)}% ${Math.round(trimRgb.l)}% / 0.3)`,
    glow: 'none',
    radius: m.radius ?? BASE_LOOK.radius,
    radiusCard: m.radiusCard ?? BASE_LOOK.radiusCard,
    pattern: m.pattern ?? BASE_LOOK.pattern,
  };
}

/** "Start from a pack then tweak": reads a pack's page and accent back into slider positions. */
export function mixFromPack(a: Accent): MixSpec {
  const bg = hexToHsl(a.bg);
  const ac = hexToHsl(a.accent);
  const dark = a.scheme !== 'light';
  return normaliseMix({
    base: a.scheme,
    sh: Math.round(bg.h),
    ss: Math.round(Math.min(100, bg.s / (dark ? 0.55 : 0.45))),
    sd: Math.round(dark ? ((bg.l - 2) / 10) * 100 : ((99 - bg.l) / 8) * 100),
    ah: Math.round(ac.h),
    as: Math.round(ac.s),
    al: Math.round(dark ? (ac.l - 40) / 0.45 : (ac.l - 20) / 0.35),
    radius: a.radius,
    radiusCard: a.radiusCard,
    pattern: a.pattern,
  });
}
