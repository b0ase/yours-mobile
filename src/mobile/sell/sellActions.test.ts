import { afterEach, describe, expect, test } from 'bun:test';
import { myListings } from './sellActions';
import { cancelKeyID, type ListingRecord } from './sell';

const TOKEN = 'b'.repeat(64) + '_0';
const rec = (outpoint: string, createdAt: number): ListingRecord => ({
  outpoint,
  tokenId: TOKEN,
  symbol: 'TESTY',
  dec: 0,
  amount: '1',
  priceSats: 500,
  keyID: cancelKeyID(TOKEN),
  createdAt,
});
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('myListings status', () => {
  test('live when the index has the unspent OrdLock, indexing while fresh, gone after the grace period', async () => {
    let url = '';
    globalThis.fetch = (async (u: string) => {
      url = String(u);
      return new Response(JSON.stringify([{ outpoint: 'aa.0', score: 1 }]));
    }) as unknown as typeof fetch;
    const now = 1_000_000_000;
    const rows = await myListings([rec('aa.0', 0), rec('bb.0', now - 60_000), rec('cc.0', 0)], now);
    expect(rows.map((r) => r.status)).toEqual(['live', 'indexing', 'gone']);
    expect(url).toContain(encodeURIComponent(`bsv21:${TOKEN}`));
    expect(url).toContain('unspent=true');
  });

  test('indexer down: nothing is marked gone', async () => {
    globalThis.fetch = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    const rows = await myListings([rec('aa.0', 0)], 1e12);
    expect(rows[0].status).toBe('indexing');
  });
});
