/** wocTxKnownLookup (review 16, F4): WhatsOnChain /tx/hash answers whether a transaction exists; nothing else counts. */
import { describe, expect, test } from 'bun:test';
import { wocChainLookups, wocTxKnownLookup } from './seedChange';

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

describe('wocChainLookups (review 16b, R4)', () => {
  test('the spent and transaction lookups share one pacer: the second call waits its turn', async () => {
    const waits: number[] = [];
    const f = async (url: string) =>
      url.includes('/spent') ? new Response('', { status: 404 }) : new Response(JSON.stringify({ txid: TXID }));
    const { spent, txKnown } = wocChainLookups({
      fetch: f,
      minIntervalMs: 1000,
      sleep: async (ms) => void waits.push(ms),
    });
    expect((await spent(`${TXID}.0`)).state).toBe('unspent');
    expect(await txKnown(TXID)).toBe('known');
    expect(waits.some((ms) => ms > 900)).toBe(true); // with two pacers the second call would not wait
  });
});
