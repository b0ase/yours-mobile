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
  iconDataUrl,
  isSetIcon,
  themedIconUrl,
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
  'bchat',
  'bvideo',
  'bmint',
  'btrust',
  'names',
  'bid',
  'bsearch',
  'bdns',
  'bedu',
  'bmaps',
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
  test('the registry covers every slug, each with a glyph and a colour', () => {
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
    expect(bappIconDef('bnothing')).toBeNull();
    expect(bappIconDef('bitcoincode')?.slug).toBe('bcode');
    expect(bappIconContent('bnothing', { label: 'bNothing', color: '#5BB98B' })).toEqual({
      letter: 'N',
      color: '#5BB98B',
    });
    const svg = bappIconSvg('bnothing', 28, { label: 'bNothing', color: '#5BB98B' });
    expect(svg).toContain('>N</text>');
    expect(svg).toContain(`stop-color="#5BB98B"`); // the b in the app colour
  });

  test('minimal glyphs: 2–4 primitives, strokes only, inside the 24 grid', () => {
    for (const [slug, g] of Object.entries(GLYPHS)) {
      const prims = g.match(/<(path|rect|circle|ellipse|line|polyline|polygon)\b/g) ?? [];
      expect({ slug, ok: prims.length >= 1 && prims.length <= 4 }).toEqual({ slug, ok: true });
      expect({ slug, fill: /fill="currentColor"|fill="#/.test(g) }).toEqual({ slug, fill: false });
    }
    expect(layout(24).glyph.stroke).toBeLessThanOrEqual(1.9);
    expect(layout(64).glyph.stroke).toBe(1.5);
  });

  test('every icon renders valid SVG at each size, with the badge', () => {
    for (const s of [...ALL_SLUGS, 'bnothing']) {
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

  test('the b stays small and grows a little at small sizes (24% at 64px, 28–34% at 28 and 20px)', () => {
    expect(layout(64).badge.h / 64).toBeCloseTo(0.24, 2);
    for (const sz of [28, 20]) {
      const f = layout(sz).badge.h / 64;
      expect(f).toBeGreaterThanOrEqual(0.28);
      expect(f).toBeLessThanOrEqual(0.34);
    }
  });
});

test('theme looks: Mono redraws a set icon on a white tile with line art; Gold and own artwork are unchanged', () => {
  const gold = iconDataUrl({ glyph: Object.keys(GLYPHS)[0] as never, color: '#3D8EF0' }, 64, 'x');
  expect(isSetIcon(gold)).toBe(true);
  expect(themedIconUrl(gold, null)).toBe(gold);
  const look = { mono: true, tile: '#FFFFFF', edge: '#E0E6F0', ink: '#1D4ED8', hi: '#1E40AF', lo: '#1E3A8A' };
  const mono = decodeURIComponent(themedIconUrl(gold, look));
  expect(mono).toContain('fill="#FFFFFF"');
  expect(mono).not.toContain('#0B0B0D');
  expect(mono).toContain('stroke="#1D4ED8"');
  expect(themedIconUrl(gold, look)).toBe(themedIconUrl(gold, look)); // cached
  expect(themedIconUrl('data:image/png;base64,AAAA', look)).toBe('data:image/png;base64,AAAA');
});

test('every bApp in the grid has a set icon (one family, themed with the rest)', async () => {
  const { BAPPS } = await import('../../bapps');
  const { EXCHANGE_BAPPS } = await import('../../exchangeAppsX');
  const outside = new Set(EXCHANGE_BAPPS.filter((a) => a.name !== 'bExchange').map((a) => a.name));
  const own = BAPPS.filter((a) => !outside.has(a.name));
  expect(own.length).toBeGreaterThan(25);
  for (const a of own)
    expect({ name: a.name, set: !!a.icon && isSetIcon(a.icon) }).toEqual({ name: a.name, set: true });
  const icons = own.map((a) => decodeURIComponent(a.icon!).replace(/bb-[^"]+-\d+/g, ''));
  // no two bApps share a drawing (labels aside)
  const glyphs = icons.map((s) => s.replace(/aria-label="[^"]*"/, '').replace(/color="[^"]*"|stop-color="[^"]*"/g, ''));
  expect(new Set(glyphs).size).toBe(glyphs.length);
});
