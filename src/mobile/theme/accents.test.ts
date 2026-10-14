import { describe, expect, test } from 'bun:test';
import { ACCENTS, accentById, accentVars, contrast, rgbTriplet } from './accents';

describe('app accents', () => {
  test('gold is first and the default', () => {
    expect(ACCENTS[0]?.id).toBe('gold');
    expect(ACCENTS[0]?.label).toBe('Classic');
    expect(accentById('nope').id).toBe('gold');
    expect(accentById(null).id).toBe('gold');
  });
  test('every accent passes WCAG AA on the black base, both ways', () => {
    for (const a of ACCENTS) {
      for (const c of [a.accent, a.hi, a.lo]) {
        expect(contrast(c, a.bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(c, a.surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(a.on, c)).toBeGreaterThanOrEqual(4.5);
      }
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
    for (const c of [a.accent, a.hi, a.lo, a.on]) expect(/A1FF8B|9EFF8A|34D399/i.test(c)).toBe(false);
});

test('every theme maps to a complete variable set, with white text readable on its page and surface', () => {
  const keys = Object.keys(accentVars(accentById('gold'))).sort();
  expect(keys.length).toBe(14);
  for (const a of ACCENTS) {
    const v = accentVars(a);
    expect(Object.keys(v).sort()).toEqual(keys);
    for (const val of Object.values(v)) expect(val.length).toBeGreaterThan(0);
    expect(contrast('#FFFFFF', a.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#FFFFFF', a.surface)).toBeGreaterThanOrEqual(4.5);
  }
});
