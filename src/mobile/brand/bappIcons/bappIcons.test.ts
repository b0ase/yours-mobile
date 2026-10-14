import { describe, expect, test } from 'bun:test';
import { FEED_COLORS } from '../../feed/feeds';
import {
  BAPP_ICONS,
  bappIconContent,
  bappIconDef,
  bappIconSvg,
  bappIconUrl,
  GLYPHS,
  ICON_SIZES,
  badgeColors,
  layout,
} from '.';

const SIXTEEN = [
  'bmovies',
  'bmusic',
  'bnews',
  'bradio',
  'bgames',
  'bart',
  'b3d',
  'bphotos',
  'bbooks',
  'bwriter',
  'bmail',
  'bsocial',
  'bchatx',
  'bexchange',
  'bcredits',
  'bshares',
];

/** Well-formed SVG: parses as XML with an <svg> root (DOMParser where present, else tag balance). */
const wellFormed = (svg: string) => {
  const stack: string[] = [];
  for (const m of svg.matchAll(/<(\/?)([a-zA-Z]+)[^>]*?(\/?)>/g)) {
    if (m[3]) continue;
    if (m[1]) {
      if (stack.pop() !== m[2]) return false;
    } else stack.push(m[2]);
  }
  return stack.length === 0 && svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"');
};

describe('bApp icon set', () => {
  test('the registry covers all 16, each with a glyph and a colour', () => {
    expect(Object.keys(BAPP_ICONS).sort()).toEqual([...SIXTEEN].sort());
    for (const s of SIXTEEN) {
      expect(GLYPHS[s as keyof typeof GLYPHS]).toBeTruthy();
      expect(BAPP_ICONS[s as keyof typeof BAPP_ICONS].color).toMatch(/^#[0-9A-F]{6}$/i);
    }
    expect(BAPP_ICONS.bmovies.color).toBe(FEED_COLORS.bmovies);
    expect(bappIconDef('bgame')?.slug).toBe('bgames');
    expect(bappIconDef('writer')?.slug).toBe('bwriter');
  });

  test('a slug with no glyph gets the fallback initial in its colour', () => {
    expect(bappIconDef('bmaps')).toBeNull();
    expect(bappIconContent('bmaps', { label: 'bMaps', color: '#5BB98B' })).toEqual({ letter: 'M', color: '#5BB98B' });
    const svg = bappIconSvg('bmaps', 28, { label: 'bMaps', color: '#5BB98B' });
    expect(svg).toContain('>M</text>');
    expect(svg).toContain('stroke="#5BB98B"'); // the badge ring in the app colour
  });

  test('every icon renders valid SVG at each size, with the badge', () => {
    for (const s of [...SIXTEEN, 'bmaps']) {
      for (const size of ICON_SIZES) {
        const svg = bappIconSvg(s, size);
        expect(wellFormed(svg)).toBe(true);
        expect(svg).toContain(`width="${size}"`);
        expect(svg).toContain('viewBox="23 8 74 100"'); // the real b from logo.svg
        expect(bappIconUrl(s, size)).toStartWith('data:image/svg+xml');
      }
    }
  });

  test('the badge (ring + b) takes each app colour; dark colours are lifted', () => {
    for (const s of SIXTEEN) {
      const c = BAPP_ICONS[s as keyof typeof BAPP_ICONS].color;
      const k = badgeColors(c);
      const svg = bappIconSvg(s, 28);
      expect(svg).toContain(`stroke="${k.ring}"`);
      expect(svg).toContain(`stop-color="${k.mid}"`);
      expect(svg).not.toContain('#FFD24D"/><stop'); // no gold b unless the app is gold
    }
    expect(badgeColors(BAPP_ICONS.bmovies.color).ring).toBe(BAPP_ICONS.bmovies.color);
    expect(badgeColors(BAPP_ICONS.bbooks.color).ring).not.toBe(BAPP_ICONS.bbooks.color);
  });

  test('the badge grows at small sizes (~40% of the tile at 28px)', () => {
    expect(layout(64).badge.d / 64).toBeCloseTo(0.3, 2);
    const at28 = layout(28).badge.d / 64;
    expect(at28).toBeGreaterThan(0.38);
    expect(at28).toBeLessThan(0.46);
    expect(layout(20).badge.d).toBeGreaterThan(layout(28).badge.d);
  });
});
