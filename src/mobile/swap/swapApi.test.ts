import { describe, expect, test } from 'bun:test';
import { activeSwaps, applyStatus, coinTileText, landedText, parseTyped, safeCoinImage, stepIndex, SwapApi, upsertSwap, withImages, type SwapRecord } from './swapApi';
import type { Http } from '../chat/api';

const rec = (o: Partial<SwapRecord> = {}): SwapRecord => ({
  id: 'abc123def456',
  createdAt: 1,
  from: 'btc',
  network: 'btc',
  label: 'BTC',
  amount: 0.01,
  toAmount: 60.9,
  payinAddress: 'bc1qdeposit',
  payinExtraId: null,
  address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
  stage: 'waiting',
  payoutTxid: null,
  validUntil: null,
  ...o,
});

describe('swaps', () => {
  test('steps follow the provider stages', () => {
    expect(stepIndex('waiting')).toBe(-1);
    expect(stepIndex('deposit_seen')).toBe(0);
    expect(stepIndex('swapping')).toBe(1);
    expect(stepIndex('sending')).toBe(2);
    expect(stepIndex('done')).toBe(3);
  });
  test('upsert replaces by id, newest first; finished ones are not active', () => {
    let l = upsertSwap([], rec());
    l = upsertSwap(l, rec({ id: 'b', createdAt: 5 }));
    l = upsertSwap(l, rec({ stage: 'done' }));
    expect(l.map((x) => x.id)).toEqual(['b', 'abc123def456']);
    expect(activeSwaps(l).map((x) => x.id)).toEqual(['b']);
  });
  test('status keeps known fields when the reply is empty', () => {
    const r = applyStatus(rec(), { stage: 'done', payoutTxid: 'f'.repeat(64), amountTo: null, validUntil: null });
    expect(r.toAmount).toBe(60.9);
    expect(r.payoutTxid).toBe('f'.repeat(64));
    expect(landedText(r)?.title).toBe('Swap finished');
    expect(landedText(rec())).toBeNull();
  });
  test('typed amounts', () => {
    expect(parseTyped('0,01')).toBe(0.01);
    expect(parseTyped('x')).toBeNull();
  });
  test('client calls the bit-sign proxy, never ChangeNOW directly, and sends no key', async () => {
    const seen: { url: string; body?: string; headers?: Record<string, string> }[] = [];
    const http: Http = async (req) => {
      seen.push({ url: req.url, body: req.body === undefined ? undefined : JSON.stringify(req.body), headers: req.headers });
      if (req.url.includes('/create')) return { status: 200, data: { id: 'x1y2z3a4b5', payinAddress: 'bc1q', payinExtraId: null, fromAmount: 0.01, toAmount: 60 } };
      if (req.url.includes('/status')) return { status: 200, data: { stage: 'sending', payoutTxid: null, amountTo: null, validUntil: null } };
      return { status: 400, data: { error: 'Pick a coin' } };
    };
    const api = new SwapApi(http, 'https://example.test');
    const c = await api.create({ ticker: 'btc', network: 'btc', label: 'BTC' }, 0.01, '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
    expect(c.payinAddress).toBe('bc1q');
    expect(seen[0].url).toBe('https://example.test/api/bitsign/swaps/create');
    expect(JSON.parse(seen[0].body!).address).toBe('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
    expect((await api.status('x1y2z3a4b5')).stage).toBe('sending');
    await expect(api.estimate({ ticker: 'btc', network: 'btc', label: 'BTC' }, 1)).rejects.toThrow('Pick a coin');
    expect(seen.every((s) => !s.url.includes('changenow') && !JSON.stringify(s.headers ?? {}).toLowerCase().includes('api-key'))).toBe(true);
  });
});

describe('coin icons', () => {
  test('tile text splits ticker and network', () => {
    expect(coinTileText({ ticker: 'usdt', network: 'trx', label: 'USDT · Tron' })).toEqual({ ticker: 'USDT', network: 'Tron' });
    expect(coinTileText({ ticker: 'btc', network: 'btc', label: 'BTC' })).toEqual({ ticker: 'BTC', network: null });
    expect(coinTileText({ ticker: 'usdc', network: 'eth', label: 'USDC' })).toEqual({ ticker: 'USDC', network: 'Ethereum' });
  });
  test('only https images pass', () => {
    expect(safeCoinImage('https://content-api.changenow.io/uploads/btc.svg')).toBe('https://content-api.changenow.io/uploads/btc.svg');
    expect(safeCoinImage('http://x.io/a.png')).toBeNull();
    expect(safeCoinImage('javascript:alert(1)')).toBeNull();
    expect(safeCoinImage('')).toBeNull();
    expect(safeCoinImage(null)).toBeNull();
  });
  test('server images merge into the local popular list by ticker + network', () => {
    const out = withImages(
      [
        { ticker: 'usdt', network: 'trx', label: 'USDT · Tron' },
        { ticker: 'usdt', network: 'eth', label: 'USDT · Ethereum' },
      ],
      [{ ticker: 'usdt', network: 'eth', label: 'x', image: 'https://i/usdt.svg' }],
    );
    expect(out[0].image).toBeUndefined();
    expect(out[1]).toEqual({ ticker: 'usdt', network: 'eth', label: 'USDT · Ethereum', image: 'https://i/usdt.svg' });
  });
});
