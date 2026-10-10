import { describe, expect, test } from 'bun:test';
import { fetchSeries, parseCoinGecko, parseWoc } from './market';

describe('market prices', () => {
  test('CoinGecko chart parsed, sorted, junk dropped', () => {
    expect(parseCoinGecko({ prices: [[2, 5], [1, 4], ['x', 1], [3, 0]] })).toEqual([
      { t: 1, p: 4 },
      { t: 2, p: 5 },
    ]);
    expect(parseCoinGecko(null)).toEqual([]);
  });
  test('WhatsOnChain daily rates in ms', () => {
    expect(parseWoc([{ time: 2, rate: 30 }, { time: 1, rate: 0 }])).toEqual([{ t: 2000, p: 30 }]);
  });
  test('BSV falls back to WhatsOnChain when CoinGecko fails; BTC just comes back empty', async () => {
    const f = (async (url: string) =>
      url.includes('coingecko')
        ? { ok: false, json: async () => ({}) }
        : { ok: true, json: async () => [{ time: Math.floor(Date.now() / 1000) - 100, rate: 42 }] }) as unknown as typeof fetch;
    const bsv = await fetchSeries('bsv', '1M', Date.now() - 30 * 86_400_000, f);
    expect(bsv.length).toBe(1);
    expect(bsv[0].p).toBe(42);
    expect(await fetchSeries('btc', '1M', 0, f)).toEqual([]);
  });
});
