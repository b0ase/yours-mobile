import type { CardPatternId } from '../theme/accents';
import { hexToHsl, hslToHex, luminance } from '../theme/colour';

/**
 * Balance-card skins (owner, 15 Oct 2026: every card in the carousel and the All cards browser "truly
 * impressive", each in its own way). A skin = an art-directed pattern (cardPatterns.ts), a finish class for the
 * CSS layer (foil, enamel, emboss …) and the ink. Known cards get a hand-picked look; anything else (new tokens,
 * shares, baskets) gets one chosen from its id so it is stable and the set never repeats side by side.
 */
export type Finish = 'foil' | 'enamel' | 'satin' | 'neon' | 'lacquer' | 'paper';
export type Skin = { pattern: CardPatternId; colour: string; finish: Finish; ink: string };

const KNOWN: Record<string, Skin> = {
  bsv: { pattern: 'guilloche', colour: '#F5B800', finish: 'foil', ink: '#FFE9A8' },
  topup: { pattern: 'starburst', colour: '#F5B800', finish: 'enamel', ink: '#FFF6D6' },
  tickets: { pattern: 'halftone', colour: '#C77DFF', finish: 'paper', ink: '#FFE9FF' },
  mnee: { pattern: 'waves', colour: '#2BD4A4', finish: 'foil', ink: '#E6FFF6' },
  bcredits: { pattern: 'circuit', colour: '#FFC83D', finish: 'neon', ink: '#FFE9A8' },
  mandala: { pattern: 'topo', colour: '#3CC9A8', finish: 'satin', ink: '#E2FFF6' },
  pnee: { pattern: 'chevron', colour: '#FFD24D', finish: 'lacquer', ink: '#FFE9A8' },
  bcorp: { pattern: 'guilloche', colour: '#C9CED6', finish: 'foil', ink: '#F2F4F7' },
};
const ROTATION: CardPatternId[] = ['stripes', 'hex', 'topo', 'waves', 'starburst', 'circuit', 'halftone', 'chevron'];
const FINISHES: Finish[] = ['lacquer', 'satin', 'foil', 'enamel', 'neon', 'paper'];

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** A bright, saturated version of a card's base colour, so dark brand colours still draw a lively pattern. */
const vivid = (c: string) => {
  const h = hexToHsl(c);
  return hslToHex({ h: h.h, s: Math.max(h.s, 60), l: Math.min(Math.max(h.l, 52), 66) });
};

export function skinFor(id: string, colour?: string): Skin {
  const k = KNOWN[id];
  if (k) return k;
  const n = hash(id);
  const base = colour && /^#[0-9a-f]{6}$/i.test(colour) ? vivid(colour) : hslToHex({ h: n % 360, s: 70, l: 60 });
  return {
    pattern: ROTATION[n % ROTATION.length] as CardPatternId,
    colour: base,
    finish: FINISHES[(n >> 4) % FINISHES.length] as Finish,
    ink: luminance(base) > 0.5 ? '#FFFFFF' : hslToHex({ ...hexToHsl(base), l: 92 }),
  };
}
