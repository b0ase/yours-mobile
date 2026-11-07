import { describe, expect, test } from 'bun:test';
import { contrast } from './colour';
import { parseConnectTheme, type WornTheme } from './connectSiteTheme';
import { siteLookAccent } from './siteLook';
import { currentAccentId, wearSiteLook, wearingSiteLook } from './accent';
import { accentById, packVars } from './accents';
import { DARK_CARD_GROUND, ICON_RATIO, TEXT_RATIO } from './contrastGuard';
import { isLightPattern } from '../wallet/cardPatternsLight';

/** RB's connected site, 7 Nov 2026 (COO report): v2, mode light. Passes the documented checks. */
export const ARTECHEX = {
  v: 2,
  name: 'ArtechEx',
  mode: 'light',
  accent: '#002FA7',
  accentHi: '#1F3BDB',
  bg: '#F4F1EA',
  surface: '#FBFAF6',
  text: '#151311',
};

const worn = (v: Record<string, unknown>): WornTheme => {
  const p = parseConnectTheme(v, 'https://shop.example');
  if (!p.theme) throw new Error('bad');
  return { ...p.theme, origin: 'https://shop.example' };
};

describe('siteLookAccent', () => {
  const dark = worn({
    v: 2,
    name: 'Ember',
    mode: 'dark',
    accent: '#E8B04A',
    bg: '#0F2A1F',
    surface: '#173A2C',
    text: '#F5EBDD',
  });
  const light = worn({
    v: 2,
    name: 'Paper',
    mode: 'light',
    accent: '#B4261A',
    bg: '#FFFFFF',
    surface: '#F6F6F6',
    text: '#111111',
  });
  test('keeps the validated colours and stays readable', () => {
    for (const t of [dark, light]) {
      const a = siteLookAccent(t);
      expect(a.bg).toBe(t.bg);
      expect(a.accent).toBe(t.accent);
      expect(a.scheme).toBe(t.mode);
      for (const g of [a.bg, a.surface, a.surface2]) {
        expect(contrast(a.text, g)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(a.muted, g)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
  test('ArtechEx (light): every themed pair reads, success / danger included', () => {
    const a = siteLookAccent(worn(ARTECHEX));
    const grounds = [a.bg, a.surface, a.surface2, a.nav];
    for (const g of grounds) {
      for (const fg of [a.text, a.muted, a.hi, a.success, a.danger])
        expect(contrast(fg, g)).toBeGreaterThanOrEqual(TEXT_RATIO);
      expect(contrast(a.accent, g)).toBeGreaterThanOrEqual(ICON_RATIO);
    }
    for (const fill of [a.accent, a.hi, a.lo]) expect(contrast(a.on, fill)).toBeGreaterThanOrEqual(TEXT_RATIO);
    // The site's own colours are kept.
    expect([a.accent, a.hi, a.bg, a.surface, a.text]).toEqual(['#002FA7', '#1F3BDB', '#F4F1EA', '#FBFAF6', '#151311']);
  });
  test('ArtechEx (light): the card is a light card, never the dark pattern under a dark shade', () => {
    const a = siteLookAccent(worn(ARTECHEX));
    expect(a.paper).toBe(true);
    expect(isLightPattern(a.pattern)).toBe(true);
    expect(a.shadow).not.toBe('0 10px 30px rgb(0 0 0 / 0.5)');
  });
  test('ArtechEx (light): the dark card face gets its own readable accent ink', () => {
    const v = packVars(siteLookAccent(worn(ARTECHEX)));
    const hi = v['--bw-dark-ground-hi'] as string;
    expect(contrast(hi, DARK_CARD_GROUND)).toBeGreaterThanOrEqual(TEXT_RATIO);
    expect(contrast(v['--bw-dark-ground-on'] as string, hi)).toBeGreaterThanOrEqual(TEXT_RATIO);
  });
  test('a dark site look is unchanged by the guard (pixel-identical)', () => {
    const a = siteLookAccent(dark);
    expect({
      accent: a.accent,
      hi: a.hi,
      lo: a.lo,
      on: a.on,
      text: a.text,
      muted: a.muted,
      surface2: a.surface2,
      success: a.success,
      danger: a.danger,
      shadow: a.shadow,
      pattern: a.pattern,
      paper: a.paper,
    }).toEqual({
      accent: '#E8B04A',
      hi: '#E8B04A',
      lo: '#A7883D',
      on: '#000000',
      text: '#F5EBDD',
      muted: '#A7AD9F',
      surface2: '#244537',
      success: '#3DDC97',
      danger: '#F97066',
      shadow: '0 10px 30px rgb(0 0 0 / 0.5)',
      pattern: 'topo',
      paper: undefined,
    });
  });
  test('worn over the view and put back', () => {
    const before = currentAccentId();
    wearSiteLook(siteLookAccent(dark));
    expect(wearingSiteLook()).toBe(true);
    expect(accentById('custom').label).toBe('Ember');
    wearSiteLook(null);
    expect(wearingSiteLook()).toBe(false);
    expect(currentAccentId()).toBe(before);
  });
});
