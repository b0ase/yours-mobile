import { describe, expect, test } from 'bun:test';
import { contrast, hslToHex, mix } from './colour';
import {
  DARK_CARD_GROUND,
  DARK_CARD_INK,
  ICON_RATIO,
  TEXT_RATIO,
  contrastPick,
  guardInk,
  guardLook,
  darkGroundInks,
} from './contrastGuard';
import { ACCENTS, BASE_LOOK, type Accent } from './accents';

describe('contrastPick', () => {
  test('light ink on a dark ground, dark ink on a light one', () => {
    expect(contrastPick('#000000')).toBe('#FFFFFF');
    expect(contrastPick('#0A0B0D')).toBe('#FFFFFF');
    expect(contrastPick('#002FA7')).toBe('#FFFFFF');
    expect(contrastPick('#FFFFFF')).toBe('#000000');
    expect(contrastPick('#F4F1EA')).toBe('#000000');
    expect(contrastPick('#F7DA4A')).toBe('#000000');
  });
  test('takes the caller’s own light and dark inks', () => {
    expect(contrastPick('#0A0B0D', '#F2F2F0', '#151311')).toBe('#F2F2F0');
    expect(contrastPick('#FBFAF6', '#F2F2F0', '#151311')).toBe('#151311');
  });
  test('whichever it picks reads better than the other', () => {
    for (const bg of ['#777777', '#808080', '#3366CC', '#CC3366', '#2ECC71', '#F04438']) {
      const p = contrastPick(bg);
      const other = p === '#FFFFFF' ? '#000000' : '#FFFFFF';
      expect(contrast(p, bg)).toBeGreaterThanOrEqual(contrast(other, bg));
    }
  });
});

describe('guardInk', () => {
  test('a pair that already reads is left exactly as it is', () => {
    expect(guardInk('#151311', ['#F4F1EA', '#FBFAF6'])).toBe('#151311');
    expect(guardInk('#ffffff', '#010101')).toBe('#FFFFFF');
    // Gold's own pairs: unchanged.
    expect(guardInk('#FFD24D', '#010101')).toBe('#FFD24D');
  });
  test('text under 4.5:1 falls back to a readable ink (the reported pairs)', () => {
    // White total / History / Swap title on ArtechEx paper.
    const a = guardInk('#FFFFFF', ['#F4F1EA', '#FBFAF6']);
    expect(contrast(a, '#F4F1EA')).toBeGreaterThanOrEqual(TEXT_RATIO);
    expect(contrast(a, '#FBFAF6')).toBeGreaterThanOrEqual(TEXT_RATIO);
    // ArtechEx's accentHi on the dark card face (the Scan pill).
    const b = guardInk('#1F3BDB', DARK_CARD_GROUND);
    expect(contrast(b, DARK_CARD_GROUND)).toBeGreaterThanOrEqual(TEXT_RATIO);
    // Red "% today" on paper.
    const c = guardInk('#F04438', ['#F4F1EA', '#FBFAF6']);
    expect(contrast(c, '#FBFAF6')).toBeGreaterThanOrEqual(TEXT_RATIO);
  });
  test('icons need 3:1, text 4.5:1', () => {
    // #6E7FD6 on white: about 3.7:1, enough for an icon, not for text.
    expect(contrast('#6E7FD6', '#FFFFFF')).toBeGreaterThan(ICON_RATIO);
    expect(contrast('#6E7FD6', '#FFFFFF')).toBeLessThan(TEXT_RATIO);
    expect(guardInk('#6E7FD6', '#FFFFFF', 'icon')).toBe('#6E7FD6');
    const t = guardInk('#6E7FD6', '#FFFFFF', 'text');
    expect(t).not.toBe('#6E7FD6');
    expect(contrast(t, '#FFFFFF')).toBeGreaterThanOrEqual(TEXT_RATIO);
    // Dark navy icons on the dark dock: fixed for icons too.
    expect(contrast(guardInk('#1F3BDB', '#17191E', 'icon'), '#17191E')).toBeGreaterThanOrEqual(ICON_RATIO);
  });
  test('keeps the hue where it can (a navy accent on a dark ground turns light blue, not grey)', () => {
    const g = guardInk('#1F3BDB', DARK_CARD_GROUND);
    const [r, , b] = [1, 3, 5].map((i) => parseInt(g.slice(i, i + 2), 16)) as [number, number, number];
    expect(b).toBeGreaterThan(r);
  });
  test('every ground counts: a colour that reads on one of two grounds is not enough', () => {
    const g = guardInk('#777777', ['#FFFFFF', '#000000']);
    // Nothing reaches 4.5 on both pure white and pure black, so it falls back to the better of black and white.
    expect(['#000000', '#FFFFFF']).toContain(g);
  });
});

const ARTECHEX: Accent = {
  ...BASE_LOOK,
  id: 'custom',
  kind: 'theme',
  label: 'ArtechEx',
  scheme: 'light',
  paper: true,
  accent: '#002FA7',
  hi: '#1F3BDB',
  lo: '#4969BB',
  on: '#FFFFFF',
  bg: '#F4F1EA',
  surface: '#FBFAF6',
  surface2: '#ECEAE4',
  nav: '#F4F1EA',
  text: '#151311',
  muted: '#5E5B57',
  line: '#D9D6D0',
};

describe('guardLook', () => {
  // Review of 33ac39c6: `on` was picked against the accent stops BEFORE the guard darkened them, so Buy BSV's black
  // text sat at 4.01:1 (periwinkle) and 3.71:1 (orange) on the stops actually painted.
  const stopsRead = (g: Accent) => {
    for (const fill of [g.accent, g.hi, g.lo]) expect([fill, contrast(g.on, fill) >= TEXT_RATIO]).toEqual([fill, true]);
  };
  test('on-accent is picked after the stops are guarded (periwinkle: accent #5B6CFF, accentHi #8A96FF)', () => {
    const g = guardLook({
      ...ARTECHEX,
      accent: '#5B6CFF',
      hi: '#8A96FF',
      lo: mix('#5B6CFF', ARTECHEX.bg, 0.3),
      on: '#000000',
    });
    expect(g.hi).not.toBe('#8A96FF');
    stopsRead(g);
  });
  test('on-accent is picked after the stops are guarded (orange)', () => {
    const g = guardLook({
      ...ARTECHEX,
      accent: '#C2590A',
      hi: '#F28C28',
      lo: mix('#C2590A', ARTECHEX.bg, 0.3),
      on: '#000000',
    });
    stopsRead(g);
    for (const bg of [g.bg, g.surface, g.surface2]) expect(contrast(g.hi, bg)).toBeGreaterThanOrEqual(TEXT_RATIO);
  });
  test('a light look built on the dark base: success/danger and on-accent are made readable', () => {
    const g = guardLook({ ...ARTECHEX, on: '#000000' });
    const grounds = [g.bg, g.surface, g.surface2];
    for (const bg of grounds) {
      for (const fg of [g.text, g.muted, g.hi, g.success, g.danger])
        expect(contrast(fg, bg)).toBeGreaterThanOrEqual(TEXT_RATIO);
      expect(contrast(g.accent, bg)).toBeGreaterThanOrEqual(ICON_RATIO);
    }
    for (const fill of [g.accent, g.hi, g.lo]) expect(contrast(g.on, fill)).toBeGreaterThanOrEqual(TEXT_RATIO);
    // BASE_LOOK's success / danger are pale (made for black); on paper they are darkened.
    expect(g.success).not.toBe(BASE_LOOK.success);
    expect(g.danger).not.toBe(BASE_LOOK.danger);
  });
  test('a look that already passes comes back unchanged (every bundled pack)', () => {
    for (const a of ACCENTS.filter((x) => x.kind === 'theme' && x.group !== 'edition')) {
      const g = guardLook(a);
      for (const k of ['text', 'muted', 'accent', 'on'] as const) expect([a.id, k, g[k]]).toEqual([a.id, k, a[k]]);
    }
  });
});

describe('darkGroundInks', () => {
  test('a light pack’s dark accent gets the face’s light ink on the dark card face (a contrast pick)', () => {
    const d = darkGroundInks(ARTECHEX);
    expect(d.hi).toBe(DARK_CARD_INK);
    expect(d.on).toBe('#000000');
    expect(contrast(d.hi, DARK_CARD_GROUND)).toBeGreaterThanOrEqual(TEXT_RATIO);
    expect(contrast(d.on, d.hi)).toBeGreaterThanOrEqual(TEXT_RATIO);
  });
  test('the $name pill fades from hi to lo on that face: its ink reads on both stops', () => {
    for (const a of [ARTECHEX, ...ACCENTS.filter((x) => x.scheme === 'light')]) {
      const d = darkGroundInks(a);
      for (const stop of [d.hi, d.lo])
        expect([a.id, stop, contrast(d.on, stop) >= TEXT_RATIO]).toEqual([a.id, stop, true]);
      expect(contrast(d.hi, DARK_CARD_GROUND)).toBeGreaterThanOrEqual(TEXT_RATIO);
    }
  });
  test('Gold keeps its own gold on the dark card', () => {
    const gold = ACCENTS.find((a) => a.id === 'gold') as Accent;
    expect(darkGroundInks(gold).hi).toBe(gold.hi.toUpperCase());
  });
});

describe('guardLook: 10,000 random light themes (fixed seed)', () => {
  // Re-review of 83eab062: moving a stop to suit the on-accent ink could re-lighten hi after it was darkened for the
  // paper, so hi-coloured text (Scan, links, active tabs) fell to 3.7-4.5:1 on paper in ~6% of mid-tone themes.
  const rand = (() => {
    let t = 0x5eed1234;
    return () => {
      t = (t + 0x6d2b79f5) | 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  })();
  const between = (lo: number, hi: number) => lo + (hi - lo) * rand();
  test('hi reads on the paper and the on-accent ink reads on every accent stop', () => {
    const bad: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      const h = between(0, 360);
      const bg = hslToHex({ h: between(0, 360), s: between(0, 60), l: between(88, 99) });
      const surface = hslToHex({ h: between(0, 360), s: between(0, 40), l: between(93, 100) });
      const accent = hslToHex({ h, s: between(30, 100), l: between(20, 70) });
      const hi = hslToHex({ h: h + between(-20, 20), s: between(30, 100), l: between(20, 75) });
      const g = guardLook({
        ...ARTECHEX,
        accent,
        hi,
        lo: mix(accent, bg, 0.3),
        on: contrastPick(accent),
        bg,
        surface,
        surface2: mix(surface, ARTECHEX.text, 0.06),
        nav: bg,
      });
      const paper = Math.min(...[g.bg, g.surface, g.surface2].map((c) => contrast(g.hi, c)));
      const onStops = Math.min(...[g.accent, g.hi, g.lo].map((c) => contrast(g.on, c)));
      if (paper < TEXT_RATIO || onStops < TEXT_RATIO)
        bad.push(`${accent}/${hi} on ${bg}: hi ${paper.toFixed(2)}, on ${onStops.toFixed(2)}`);
    }
    expect(bad.slice(0, 10)).toEqual([]);
    expect(bad.length).toBe(0);
  });
});
