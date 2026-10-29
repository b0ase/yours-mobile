import { describe, expect, test } from 'bun:test';
import fwuit from '../../../docs/themes/fwuit-offer.json';
import { EMPTY_MEMORY, afterAnswer, offerBlocked, offerSite, parseThemeOffer } from './themeOffer';

const bchatx = { id: 'bchatx', host: 'bchatx.com' };

describe('theme offers: validation', () => {
  test('the FWUIT look passes and is saved as its own site theme', () => {
    const p = parseThemeOffer(fwuit, bchatx);
    expect(p).not.toBeNull();
    expect(p!.id).toBe('site-bchatx-fwuit');
    expect(p!.label).toBe('FWUIT');
    expect(p!.look.scheme).toBe('light');
    expect(p!.look.accent).toBe('#E8173A');
    expect(p!.tier).toBe('free');
  });
  test("the site's own id keeps the plain site id", () => {
    expect(parseThemeOffer({ ...fwuit, id: 'bchatx' }, bchatx)!.id).toBe('site-bchatx');
  });
  test('unknown keys, images, SVG and URLs are refused', () => {
    expect(parseThemeOffer({ ...fwuit, logoSvg: '<svg/>' }, bchatx)).toBeNull();
    expect(parseThemeOffer({ ...fwuit, cardArt: '/a.png' }, bchatx)).toBeNull();
    expect(parseThemeOffer({ ...fwuit, livery: { stripe: 'x' } }, bchatx)).toBeNull();
    expect(parseThemeOffer({ ...fwuit, label: 'Visit fwuit.com' }, bchatx)).toBeNull();
    expect(parseThemeOffer({ ...fwuit, label: '<b>x</b>' }, bchatx)).toBeNull();
  });
  test('colours must be #RRGGBB and readable', () => {
    expect(parseThemeOffer({ ...fwuit, accent: 'red' }, bchatx)).toBeNull();
    expect(parseThemeOffer({ ...fwuit, accent: '#E8173A; x' }, bchatx)).toBeNull();
    expect(parseThemeOffer({ ...fwuit, text: '#FFE14D' }, bchatx)).toBeNull();
    expect(parseThemeOffer({ ...fwuit, on: '#E8173A' }, bchatx)).toBeNull();
  });
  test('bad ids, versions, shapes and sizes are refused', () => {
    expect(parseThemeOffer({ ...fwuit, id: 'FWUIT' }, bchatx)).toBeNull();
    expect(parseThemeOffer({ ...fwuit, id: 'a'.repeat(25) }, bchatx)).toBeNull();
    expect(parseThemeOffer({ ...fwuit, v: 2 }, bchatx)).toBeNull();
    expect(parseThemeOffer([fwuit], bchatx)).toBeNull();
    expect(parseThemeOffer(null, bchatx)).toBeNull();
    expect(parseThemeOffer({ ...fwuit, blurb: 'x'.repeat(5000) }, bchatx)).toBeNull();
  });
  test('only family sites over https, no port', () => {
    expect(offerSite('https://www.bchatx.com')?.id).toBe('bchatx');
    expect(offerSite('https://chat.bwalletx.com')?.id).toBe('bchatx');
    expect(offerSite('http://www.bchatx.com')).toBeNull();
    expect(offerSite('https://www.bchatx.com:8443')).toBeNull();
    expect(offerSite('https://evil.example')).toBeNull();
    expect(offerSite('https://bchatx.com.evil.example')).toBeNull();
    expect(offerSite(undefined)).toBeNull();
  });
});

describe('theme offers: rate limit and Never', () => {
  const o = 'https://www.bchatx.com';
  const pack = parseThemeOffer(fwuit, bchatx)!;
  test('once per site and look per session', () => {
    expect(offerBlocked(EMPTY_MEMORY, o, pack)).toBeNull();
    const m = afterAnswer(EMPTY_MEMORY, o, pack, 'declined');
    expect(offerBlocked(m, o, pack)).toBe('asked');
    // A new session forgets what was shown.
    expect(offerBlocked({ ...m, shown: [] }, o, pack)).toBeNull();
  });
  test('Never for this site sticks across sessions and looks', () => {
    const m = { ...afterAnswer(EMPTY_MEMORY, o, pack, 'never'), shown: [] };
    expect(offerBlocked(m, o, pack)).toBe('never');
    expect(offerBlocked(m, o, { ...pack, id: 'site-bchatx-other' })).toBe('never');
    expect(offerBlocked(m, 'https://vexvoid.com', pack)).toBeNull();
  });
  test('a look already taken is not offered again unless it changed', () => {
    const m = { ...afterAnswer(EMPTY_MEMORY, o, pack, 'used'), shown: [] };
    expect(offerBlocked(m, o, pack)).toBe('worn');
    expect(offerBlocked(m, o, { ...pack, look: { ...pack.look, accent: '#C2006B' } })).toBeNull();
  });
});
