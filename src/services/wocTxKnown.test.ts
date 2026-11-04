/** wocTxKnownLookup (review 16, F4): WhatsOnChain /tx/hash answers whether a transaction exists; nothing else counts. */
import { describe, expect, test } from 'bun:test';
import { wocTxKnownLookup } from './seedChange';

const TXID = 'ab'.repeat(32);
const answer =
  (status: number, body: unknown = {}) =>
  async () =>
    new Response(JSON.stringify(body), { status });
const opts = (f: () => Promise<Response>) => ({ fetch: f, minIntervalMs: 0, sleep: async () => undefined });

describe('wocTxKnownLookup', () => {
  test('200 for this txid: known; 404: unknown', async () => {
    expect(await wocTxKnownLookup(opts(answer(200, { txid: TXID })))(TXID)).toBe('known');
    expect(await wocTxKnownLookup(opts(answer(404)))(TXID)).toBe('unknown');
  });
  test('an answer about another transaction, 429 or 5xx throughout, or a bad txid: unclear', async () => {
    expect(await wocTxKnownLookup(opts(answer(200, { txid: 'cd'.repeat(32) })))(TXID)).toBe('unclear');
    expect(await wocTxKnownLookup(opts(answer(429)))(TXID)).toBe('unclear');
    expect(await wocTxKnownLookup(opts(answer(503)))(TXID)).toBe('unclear');
    expect(await wocTxKnownLookup(opts(answer(200, { txid: TXID })))('nope')).toBe('unclear');
  });
  test('a 503 then 200 is retried to known', async () => {
    let n = 0;
    const f = async () =>
      n++ === 0 ? new Response('', { status: 503 }) : new Response(JSON.stringify({ txid: TXID }));
    expect(await wocTxKnownLookup(opts(f))(TXID)).toBe('known');
  });
});
