import { describe, expect, test } from 'bun:test';
import { ACCENTS, THEMES, accentById, accentVars, contrast, packVars, rgbTriplet } from './accents';

describe('app accents and packs', () => {
  test('gold is first and the default', () => {
    expect(ACCENTS[0]?.id).toBe('gold');
    expect(ACCENTS[0]?.label).toBe('Gold');
    expect(accentById('nope').id).toBe('gold');
    expect(accentById(null).id).toBe('gold');
    expect(accentById('custom').id).toBe('gold'); // no mix primed yet
  });
  test('at least 8 full packs', () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(8);
    for (const id of ['gold', 'executive', 'cyber', 'paper', 'midnight', 'forest', 'sunset', 'monolight', 'contrast'])
      expect(THEMES.some((t) => t.id === id)).toBe(true);
  });
  test('every pack passes WCAG AA: text, muted and accent on page and surfaces; on-accent on the accent', () => {
    for (const a of ACCENTS) {
      for (const g of [a.bg, a.surface]) {
        expect(contrast(a.text, g)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(a.muted, g)).toBeGreaterThanOrEqual(4.5);
        for (const c of [a.accent, a.hi, a.lo]) expect(contrast(c, g)).toBeGreaterThanOrEqual(4.5);
      }
      for (const c of [a.accent, a.hi, a.lo]) expect(contrast(a.on, c)).toBeGreaterThanOrEqual(4.5);
    }
  });
  test('gold matches the existing tokens (src/accent.css)', () => {
    const v = accentVars(accentById('gold'));
    expect(v['--bw-accent']).toBe('#F5B800');
    expect(v['--bw-accent-hi']).toBe('#FFD24D');
    expect(v['--bw-accent-lo']).toBe('#EAB300');
    expect(rgbTriplet('#F5B800')).toBe('245 184 0');
  });
});

test('no accent uses a colour the bcorp build rewrites', () => {
  for (const a of ACCENTS)
    for (const c of [a.accent, a.hi, a.lo, a.on, a.success, a.text, a.muted, a.bg, a.surface, a.line])
      expect(/A1FF8B|9EFF8A|34D399/i.test(c)).toBe(false);
});

test('every pack maps to a complete variable set', () => {
  const keys = Object.keys(packVars(accentById('gold'))).sort();
  expect(keys).toContain('--bw-text');
  expect(keys).toContain('--bw-line');
  for (const a of ACCENTS) {
    const v = packVars(a);
    expect(Object.keys(v).sort()).toEqual(keys);
    for (const val of Object.values(v)) expect(val.length).toBeGreaterThan(0);
  }
});
