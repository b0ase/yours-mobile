import { describe, expect, test } from 'bun:test';
import fwuit from '../../docs/themes/fwuit-offer.json';
import { EMPTY_MEMORY, type OfferMemory, type ThemeOfferResult } from '../mobile/theme/themeOffer';
import { runThemeOffer, type ThemeOfferDeps } from './themeOfferSite';

const deps = (answer: ThemeOfferResult, locked = false) => {
  let mem: OfferMemory = EMPTY_MEMORY;
  const asks: { host: string; id: string }[] = [];
  const d: ThemeOfferDeps = {
    locked: async () => locked,
    load: async () => mem,
    save: async (m) => {
      mem = m;
    },
    ask: async ({ host, pack }) => {
      asks.push({ host, id: pack.id });
      return answer;
    },
  };
  return { d, asks, mem: () => mem, newSession: () => (mem = { ...mem, shown: [] }) };
};

describe('CWI.theme.offer', () => {
  test('a family site gets one sheet and the answer', async () => {
    const t = deps('used');
    const r = await runThemeOffer('https://www.bchatx.com', true, fwuit, t.d);
    expect(r).toEqual({ success: true, data: { result: 'used' } });
    expect(t.asks).toEqual([{ host: 'www.bchatx.com', id: 'site-bchatx-fwuit' }]);
  });
  test('other sites, sub-frames and bad looks never reach the sheet', async () => {
    const t = deps('used');
    expect(await runThemeOffer('https://evil.example', true, fwuit, t.d)).toMatchObject({ code: 'ORIGIN' });
    expect(await runThemeOffer('https://www.bchatx.com', false, fwuit, t.d)).toMatchObject({ code: 'ORIGIN' });
    expect(await runThemeOffer('https://www.bchatx.com', true, { ...fwuit, x: 1 }, t.d)).toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(t.asks).toHaveLength(0);
  });
  test('a locked wallet is skipped, never asked to unlock', async () => {
    const t = deps('used', true);
    expect(await runThemeOffer('https://www.bchatx.com', true, fwuit, t.d)).toEqual({
      success: true,
      data: { result: 'skipped', reason: 'locked' },
    });
    expect(t.asks).toHaveLength(0);
  });
  test('Not now: once per session', async () => {
    const t = deps('declined');
    await runThemeOffer('https://www.bchatx.com', true, fwuit, t.d);
    const again = await runThemeOffer('https://www.bchatx.com', true, fwuit, t.d);
    expect(again).toEqual({ success: true, data: { result: 'skipped', reason: 'asked' } });
    t.newSession();
    await runThemeOffer('https://www.bchatx.com', true, fwuit, t.d);
    expect(t.asks).toHaveLength(2);
  });
  test('Never for this site is remembered across sessions', async () => {
    const t = deps('never');
    await runThemeOffer('https://www.bchatx.com', true, fwuit, t.d);
    t.newSession();
    const r = await runThemeOffer('https://www.bchatx.com', true, { ...fwuit, id: 'another' }, t.d);
    expect(r).toEqual({ success: true, data: { result: 'skipped', reason: 'never' } });
    expect(t.asks).toHaveLength(1);
    expect(t.mem().never).toEqual(['https://www.bchatx.com']);
  });
});
