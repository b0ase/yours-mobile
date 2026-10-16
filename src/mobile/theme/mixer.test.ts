import { describe, expect, test } from 'bun:test';
import { THEMES } from './accents';
import { contrast, ensureContrast, hexToHsl, hslToHex, pickReadable } from './colour';
import { GOLD_MIX, deriveMix, mixFromPack, nextMixerOpen, normaliseMix, type MixSpec } from './mixer';

const aa = (fg: string, bg: string) => contrast(fg, bg) >= 4.5;

describe('colour helpers', () => {
  test('hex ↔ hsl round-trips', () => {
    for (const c of ['#F5B800', '#23395B', '#FFFFFF', '#000000', '#FF2BD6'])
      expect(contrast(hslToHex(hexToHsl(c)), c)).toBeLessThan(1.05);
  });
  test('ensureContrast reaches the target on dark and light grounds', () => {
    expect(aa(ensureContrast('#333333', '#000000'), '#000000')).toBe(true);
    expect(aa(ensureContrast('#EEEEEE', '#FFFFFF'), '#FFFFFF')).toBe(true);
    const mid = ensureContrast('#808080', ['#777777', '#888888']);
    expect(aa(mid, '#777777') && aa(mid, '#888888')).toBe(true);
  });
  test('pickReadable falls back to black or white', () => {
    expect(pickReadable(['#777777'], ['#FFE600'])).toBe('#000000');
  });
});

describe('colour mixer', () => {
  test('clamps junk input', () => {
    const m = normaliseMix({ sh: 999, ss: -4, sd: Number.NaN, base: 'x' as 'dark' } as Partial<MixSpec>);
    expect(m.sh).toBe(360);
    expect(m.ss).toBe(0);
    expect(m.base).toBe('dark');
  });
  test('every slider combination stays readable (WCAG AA)', () => {
    let n = 0;
    for (const base of ['dark', 'light'] as const)
      for (const sh of [0, 120, 240, 330])
        for (const ss of [0, 50, 100])
          for (const sd of [0, 50, 100])
            for (const ah of [0, 60, 200])
              for (const as of [0, 100])
                for (const al of [0, 50, 100]) {
                  const p = deriveMix({ base, sh, ss, sd, ah, as, al });
                  for (const g of [p.bg, p.surface, p.surface2]) {
                    expect(aa(p.text, g)).toBe(true);
                    expect(aa(p.muted, g)).toBe(true);
                    expect(aa(p.accent, g)).toBe(true);
                    expect(aa(p.hi, g)).toBe(true);
                    expect(aa(p.lo, g)).toBe(true);
                    expect(aa(p.danger, g)).toBe(true);
                  }
                  for (const c of [p.accent, p.hi, p.lo]) expect(aa(p.on, c)).toBe(true);
                  n++;
                }
    expect(n).toBeGreaterThan(1000);
  });
  test('light base gives a light page, dark base a dark one', () => {
    expect(contrast(deriveMix({ ...GOLD_MIX, base: 'light' }).bg, '#FFFFFF')).toBeLessThan(1.3);
    expect(contrast(deriveMix(GOLD_MIX).bg, '#000000')).toBeLessThan(1.3);
  });
  test('start from a pack: the mix lands close to the pack', () => {
    for (const t of THEMES) {
      if (t.paper) continue; // paper stock is a fixed colour, not a hue the mixer derives
      const d = deriveMix(mixFromPack(t));
      expect(d.scheme).toBe(t.scheme);
      expect(contrast(d.bg, t.bg)).toBeLessThan(1.35);
    }
  });
});

test('Mix your own only closes from its own toggle', () => {
  expect(nextMixerOpen(true, 'pick')).toBe(true);
  expect(nextMixerOpen(true, 'open')).toBe(true);
  expect(nextMixerOpen(false, 'open')).toBe(true);
  expect(nextMixerOpen(true, 'toggle')).toBe(false);
  expect(nextMixerOpen(false, 'toggle')).toBe(true);
  expect(nextMixerOpen(false, 'pick')).toBe(false);
});
