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

const ALL_SLUGS = [
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
  'bpaint',
  'bjobs',
  'bdrive',
  'bsheets',
  'bcal',
  'bcode',
  'bagents',
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
  test('the registry covers all 23, each with a glyph and a colour', () => {
    expect(Object.keys(BAPP_ICONS).sort()).toEqual([...ALL_SLUGS].sort());
    for (const s of ALL_SLUGS) {
      expect(GLYPHS[s as keyof typeof GLYPHS]).toBeTruthy();
      expect(BAPP_ICONS[s as keyof typeof BAPP_ICONS].color).toMatch(/^#[0-9A-F]{6}$/i);
    }
    expect(BAPP_ICONS.bmovies.color).toBe(FEED_COLORS.bmovies);
    expect(bappIconDef('bgame')?.slug).toBe('bgames');
    expect(bappIconDef('writer')?.slug).toBe('bwriter');
  });

  test('a slug with no glyph gets the fallback initial in its colour', () => {
    expect(bappIconDef('bmaps')).toBeNull();
    expect(bappIconDef('bitcoincode')?.slug).toBe('bcode');
    expect(bappIconContent('bmaps', { label: 'bMaps', color: '#5BB98B' })).toEqual({ letter: 'M', color: '#5BB98B' });
    const svg = bappIconSvg('bmaps', 28, { label: 'bMaps', color: '#5BB98B' });
    expect(svg).toContain('>M</text>');
    expect(svg).toContain(`stop-color="#5BB98B"`); // the b in the app colour
  });

  test('every icon renders valid SVG at each size, with the badge', () => {
    for (const s of [...ALL_SLUGS, 'bmaps']) {
      for (const size of ICON_SIZES) {
        const svg = bappIconSvg(s, size);
        expect(wellFormed(svg)).toBe(true);
        expect(svg).toContain(`width="${size}"`);
        expect(svg).toContain('viewBox="23 8 74 100"'); // the real b from logo.svg
        expect(bappIconUrl(s, size)).toStartWith('data:image/svg+xml');
      }
    }
  });

  test('the b takes each app colour (no disc, no ring); very dark colours are lifted', () => {
    for (const slug of ALL_SLUGS) {
      const c = BAPP_ICONS[slug as keyof typeof BAPP_ICONS].color;
      const svg = bappIconSvg(slug, 28);
      expect(svg).toContain(`stop-color="${badgeColors(c).mid}"`);
      expect(svg).not.toContain('<circle cx="60" cy="72" r="33" fill="#0B0B0D"/>');
      expect(svg).not.toMatch(/stroke="#FFD24D"/);
    }
    expect(badgeColors(BAPP_ICONS.bmovies.color).base).toBe(BAPP_ICONS.bmovies.color);
    expect(badgeColors('#4A2E1A').base).not.toBe('#4A2E1A');
  });

  test('two icons in one document: unique def ids, different badge fills', () => {
    const doc = bappIconSvg('bmovies', 28) + bappIconSvg('bmusic', 28) + bappIconSvg('bmusic', 28);
    const ids = [...doc.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBe(9);
    expect(new Set(ids).size).toBe(ids.length);
    const fills = [...doc.matchAll(/<linearGradient id="[^"]+"[^>]*><stop offset="0" stop-color="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(fills[0]).not.toBe(fills[1]);
    // each b points at its own gradient
    for (const id of ids.filter((i) => i.endsWith('-g'))) expect(doc).toContain(`url(#${id})`);
  });

  test('the b grows at small sizes (~32% at 64px, ~38–46% at 28 and 20px)', () => {
    expect(layout(64).badge.h / 64).toBeCloseTo(0.32, 2);
    for (const sz of [28, 20]) {
      const f = layout(sz).badge.h / 64;
      expect(f).toBeGreaterThanOrEqual(0.38);
      expect(f).toBeLessThanOrEqual(0.46);
    }
  });
});
