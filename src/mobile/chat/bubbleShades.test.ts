import { describe, expect, it } from 'bun:test';
import {
  AGENT_ACCOUNT_SHADE,
  BUBBLE_BASE_DARK,
  BUBBLE_BASE_LIGHT,
  BUBBLE_SHADES,
  TINT_DARK,
  TINT_LIGHT,
  assignShades,
  contrast,
  mixHex,
  shadeFor,
  shadeIndex,
  shadeVars,
} from './bubbleShades';

// Owner, 28 Oct 2026: no black bubbles on black, Telegram-style, warm yellow/orange, not a rainbow.
const hue = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b);
  const d = mx - Math.min(r, g, b);
  if (!d) return 0;
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};

describe('bubbleShades', () => {
  it('is a small warm palette (no blues, greens or purples)', () => {
    expect(BUBBLE_SHADES.length).toBeGreaterThanOrEqual(6);
    expect(BUBBLE_SHADES.length).toBeLessThanOrEqual(8);
    for (const s of [...BUBBLE_SHADES, AGENT_ACCOUNT_SHADE]) {
      expect(hue(s.ink)).toBeLessThanOrEqual(55);
      expect(hue(s.inkLight)).toBeLessThanOrEqual(55);
    }
  });

  it('passes WCAG AA for text and names on every shade, dark and light', () => {
    for (const s of [...BUBBLE_SHADES, AGENT_ACCOUNT_SHADE]) {
      const dark = mixHex(s.tint, BUBBLE_BASE_DARK, TINT_DARK + 0.02);
      const light = mixHex(s.tint, BUBBLE_BASE_LIGHT, TINT_LIGHT + 0.04);
      expect(contrast('#f2f2f2', dark)).toBeGreaterThanOrEqual(4.5);
      expect(contrast('#111111', light)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(s.ink, dark)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(s.inkLight, light)).toBeGreaterThanOrEqual(4.5);
      // lifted off the black page, never black on black
      expect(contrast(dark, '#000000')).toBeGreaterThanOrEqual(1.25);
    }
  });

  it('keeps a person on one shade everywhere, and spreads a room across the palette', () => {
    expect(shadeFor('Boase')).toBe(shadeFor('$boase'));
    expect(new Set(assignShades(['ann', 'bob', 'cat', 'dan', 'eve', 'fay', 'gus', 'hal']).values()).size).toBe(8);
    const m = assignShades(['zed', 'ann', 'zed']);
    expect(m.get('zed')).toBe(shadeFor('zed'));
    const pair: string[] = [];
    for (let i = 0; pair.length < 2 && i < 500; i++) if (shadeIndex(`u${i}`) === shadeIndex('u0')) pair.push(`u${i}`);
    const pm = assignShades(pair);
    expect(pm.get(pair[0])).not.toBe(pm.get(pair[1]));
    expect(Object.keys(shadeVars(BUBBLE_SHADES[0]))).toEqual(['--bw-ink', '--bw-ink-light', '--bw-tint']);
  });
});
