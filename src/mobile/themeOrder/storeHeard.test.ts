import { describe, expect, test } from 'bun:test';
import { KeyDeriver, PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import { askStoreHeardOf, storeAskFor, storePaymentOf } from './storeHeard';

const TX = 'ab'.repeat(32);
const QUOTE = 'cd'.repeat(16);
const memo = (tag: string, q = QUOTE) =>
  `006a${tag.length.toString(16).padStart(2, '0')}${Utils.toHex(Utils.toArray(tag, 'utf8'))}20${Utils.toHex(Utils.toArray(q, 'utf8'))}`;
const wallet = new ProtoWallet(new KeyDeriver(PrivateKey.fromRandom())) as never;
const api = 'https://store.test';
const answer = (status: number, body: unknown) => async () => Response.json(body, { status });

describe('storePaymentOf: by the wallet record alone', () => {
  test('description + memo output', () => {
    expect(
      storePaymentOf({ description: 'Theme purchase · Cool', outputs: [{}, { lockingScript: memo('bwx-theme-buy') }] }),
    ).toEqual({ kind: 'buy', quoteId: QUOTE });
    expect(
      storePaymentOf({ description: 'bWalletX theme edition', outputs: [{ lockingScript: memo('bwx-theme-order') }] }),
    ).toEqual({
      kind: 'order',
      quoteId: QUOTE,
    });
    expect(storePaymentOf({ description: 'Send', outputs: [{ lockingScript: memo('bwx-theme-buy') }] })).toBeNull();
    expect(storePaymentOf({ description: 'Theme purchase · Cool', outputs: [{ lockingScript: '6a' }] })).toBeNull();
  });
});

describe('askStoreHeardOf', () => {
  const ask = (f: (u: string, i?: RequestInit) => Promise<Response>, o: { timeoutMs?: number; api?: string } = {}) =>
    askStoreHeardOf(wallet, f, { kind: 'buy', quoteId: QUOTE }, TX, { api, ...o });
  test('clear answers', async () => {
    expect(await ask(answer(200, { unverified: true }))).toBe('no');
    expect(await ask(answer(200, { pending: true }))).toBe('yes');
    expect(await ask(answer(200, {}))).toBe('yes');
    expect(await ask(answer(409, { error: 'tx_used' }))).toBe('yes');
    for (const code of ['rawtx', 'quote_not_found', 'payment_pending', 'quote_used'])
      expect(await ask(answer(400, { error: code }))).toBe('no');
  });
  test('anything unclear is never a "no": 429, 5xx, network error, timeout, no Store address', async () => {
    expect(await ask(answer(429, { error: 'rate_limited' }))).toBe('unclear');
    expect(await ask(answer(429, {}))).toBe('unclear');
    expect(await ask(answer(503, { error: 'store_unavailable' }))).toBe('unclear');
    expect(
      await ask(async () => {
        throw new TypeError('Failed to fetch');
      }),
    ).toBe('unclear');
    expect(await ask(() => new Promise<Response>(() => undefined), { timeoutMs: 20 })).toBe('unclear');
    expect(await ask(answer(200, { unverified: true }), { api: '' })).toBe('unclear');
  });
  test('signed claim with no rawtx, to the right endpoint', async () => {
    let url = '';
    let body: Record<string, unknown> = {};
    await ask(async (u, i) => {
      url = u;
      body = JSON.parse(String(i?.body));
      return Response.json({ unverified: true });
    });
    expect(url).toBe(`${api}/api/theme-orders/buy-claim`);
    expect(body.rawtx).toBeUndefined();
    expect(body.fields).toEqual({ quote_id: QUOTE, txid: TX, store: '2' });
    expect(typeof body.signature).toBe('string');
  });
});

describe('storeAskFor', () => {
  test('not a Store payment → not-store, the Store is never asked', async () => {
    let asked = 0;
    const ask = storeAskFor(
      wallet,
      async () => {
        asked++;
        return Response.json({ unverified: true });
      },
      { api },
    );
    expect(await ask({ txid: TX, description: 'Send', outputs: [] })).toBe('not-store');
    expect(asked).toBe(0);
    const store = {
      txid: TX,
      description: 'Theme purchase · Cool',
      outputs: [{ lockingScript: memo('bwx-theme-buy') }],
    };
    expect(await ask(store)).toBe('never-heard');
    expect(await storeAskFor(wallet, answer(200, { pending: true }), { api })(store)).toBe('heard');
    expect(await storeAskFor(wallet, answer(429, {}), { api })(store)).toBe('unclear');
  });
});
