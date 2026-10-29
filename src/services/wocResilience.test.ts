import { describe, expect, test } from 'bun:test';
import {
  RATE_LIMIT_MESSAGE,
  WocRateLimited,
  addProviderFallback,
  hardenWalletServices,
  hardenWhatsOnChain,
  withBackoff,
  type HttpResponse,
} from './wocResilience';

const r429: HttpResponse = { status: 429, statusText: 'Too Many Requests', ok: false };
const r200: HttpResponse = { status: 200, statusText: 'OK', ok: true, data: 'ab' };
const scripted = (seq: HttpResponse[]) => {
  let n = 0;
  const fn = async () => seq[Math.min(n++, seq.length - 1)];
  return { fn, calls: () => n };
};
const noSleep = (log: number[] = []) => ({ sleep: async (ms: number) => void log.push(ms), random: () => 0.5 });

describe('withBackoff', () => {
  test('429 then success: retried, success returned', async () => {
    const s = scripted([r429, r429, r200]);
    const waits: number[] = [];
    const r = await withBackoff(s.fn, noSleep(waits))('u', {});
    expect(r.status).toBe(200);
    expect(s.calls()).toBe(3);
    expect(waits.length).toBe(2);
    expect(waits[1]).toBeGreaterThan(waits[0]); // exponential
  });
  test('429 every time: clear rate-limited, nothing-sent error, within ~10 s', async () => {
    const s = scripted([r429]);
    const waits: number[] = [];
    const e = await withBackoff(s.fn, noSleep(waits))('https://api.whatsonchain.com/x', {}).catch((x) => x);
    expect(e).toBeInstanceOf(WocRateLimited);
    expect(e.message).toBe(RATE_LIMIT_MESSAGE);
    expect(e.message).toMatch(/rate-limiting/);
    expect(e.message).toMatch(/Nothing was sent/);
    expect(e.code).toBe('WOC_RATE_LIMITED');
    expect(s.calls()).toBe(6);
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(10_000);
  });
  test('honours Retry-After but never past the budget', async () => {
    const s = scripted([{ ...r429, headers: { 'retry-after': '30' } }]);
    const waits: number[] = [];
    await withBackoff(s.fn, { ...noSleep(waits), budgetMs: 10_000 })('u', {}).catch(() => undefined);
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(10_000);
  });
  test('other errors pass straight through (no retry)', async () => {
    const s = scripted([{ status: 404, statusText: 'Not Found' }]);
    expect((await withBackoff(s.fn, noSleep())('u', {})).status).toBe(404);
    expect(s.calls()).toBe(1);
  });
});

describe('hardenWhatsOnChain', () => {
  test('wraps request once and sets the key only when none is set', async () => {
    const s = scripted([r429, r200]);
    const woc = { request: s.fn, apiKey: '' } as { request: typeof s.fn; apiKey: string };
    expect(hardenWhatsOnChain(woc, 'k1', noSleep())).toBe(true);
    expect(hardenWhatsOnChain(woc, 'k2', noSleep())).toBe(true);
    expect(woc.apiKey).toBe('k1');
    expect((await woc.request()).status).toBe(200);
  });
  test('no key from env: stays anonymous', () => {
    const woc = { request: async () => r200, apiKey: '' };
    hardenWhatsOnChain(woc, '');
    expect(woc.apiKey).toBe('');
  });
});

describe('provider fallback', () => {
  test('1sat fails, toolbox chain answers', async () => {
    const svc = {
      getRawTx: async () => ({ error: new Error('1sat down') }),
      getMerklePath: async () => ({ error: new Error('1sat down') }),
      fallbackServices: { getRawTx: async () => ({ rawTx: [1] }), getMerklePath: async () => ({ merklePath: {} }) },
    };
    expect(addProviderFallback(svc)).toBe(true);
    expect((await svc.getRawTx('t')).rawTx).toEqual([1]);
    expect((await svc.getMerklePath('t')).merklePath).toEqual({});
  });
  test('1sat answers: fallback never called', async () => {
    let called = 0;
    const svc = {
      getRawTx: async () => ({ rawTx: [9] }),
      getMerklePath: async () => ({ merklePath: 1 }),
      fallbackServices: { getRawTx: async () => (called++, { rawTx: [1] }), getMerklePath: async () => (called++, {}) },
    };
    addProviderFallback(svc);
    expect((await svc.getRawTx('t')).rawTx).toEqual([9]);
    expect(called).toBe(0);
  });
  test('both fail: the original 1sat result is returned (fallback throw is swallowed)', async () => {
    const orig = { error: new Error('1sat down') };
    const svc = {
      getRawTx: async () => orig,
      getMerklePath: async () => orig,
      fallbackServices: {
        getRawTx: async () => {
          throw new WocRateLimited(6, 'u');
        },
        getMerklePath: async () => ({}),
      },
    };
    addProviderFallback(svc, { sleep: async () => {} });
    expect(await svc.getRawTx('t')).toBe(orig);
  });
  test('own unconfirmed change: the stored raw tx answers, no network lookup', async () => {
    let net = 0;
    const svc = {
      getRawTx: async () => (net++, { error: new Error('not indexed yet') }),
      getMerklePath: async () => ({}),
      fallbackServices: { getRawTx: async () => (net++, {}), getMerklePath: async () => ({}) },
    };
    addProviderFallback(svc, { localRawTx: async (t) => (t === 'mine' ? [7, 7] : undefined) });
    expect((await svc.getRawTx('mine')).rawTx).toEqual([7, 7]);
    expect(net).toBe(0);
  });
  test('both fail once, then 1sat answers on the second round (after a pause)', async () => {
    let n = 0;
    const waits: number[] = [];
    const svc = {
      getRawTx: async () => (n++ === 0 ? { error: new Error('blip') } : { rawTx: [3] }),
      getMerklePath: async () => ({}),
      fallbackServices: { getRawTx: async () => ({ error: new Error('woc 404') }), getMerklePath: async () => ({}) },
    };
    addProviderFallback(svc, { retryDelayMs: 5, sleep: async (ms) => void waits.push(ms) });
    expect((await svc.getRawTx('t')).rawTx).toEqual([3]);
    expect(waits).toEqual([5]);
  });
  test('a provider that throws becomes an error result, never a thrown WERR_INTERNAL', async () => {
    const svc = {
      getRawTx: async (): Promise<{ rawTx?: number[]; error?: unknown }> => {
        throw new Error('An internal error has occurred.');
      },
      getMerklePath: async () => ({}),
      fallbackServices: { getRawTx: async () => ({ rawTx: [5] }), getMerklePath: async () => ({}) },
    };
    addProviderFallback(svc, { sleep: async () => {} });
    expect((await svc.getRawTx('t')).rawTx).toEqual([5]);
  });
  test('hardenWalletServices finds the WhatsOnChain provider behind OneSatServices', () => {
    const woc = { request: async () => r200, apiKey: '' };
    const svc = {
      getRawTx: async () => ({}),
      getMerklePath: async () => ({}),
      fallbackServices: { whatsonchain: woc, getRawTx: async () => ({}), getMerklePath: async () => ({}) },
    };
    expect(hardenWalletServices(svc, 'key')).toBe(true);
    expect(woc.apiKey).toBe('key');
  });
});
