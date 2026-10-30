import { describe, expect, test } from 'bun:test';
import { makeSwapQuote, SWAP_RATE_TTL_MS, type CachedRate } from './swapQuote';

const NOW = 1_800_000_000_000;
const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response;

function setup(cache: CachedRate | undefined, responder: (url: string) => Promise<Response>) {
  const urls: string[] = [];
  const written: { rate: number; timestamp: number }[] = [];
  const quote = makeSwapQuote({
    readCache: async () => cache,
    writeCache: async (r) => {
      written.push(r);
    },
    fetch: (async (u: string) => {
      urls.push(String(u));
      return responder(String(u));
    }) as unknown as typeof fetch,
    now: () => NOW,
    timeoutMs: 50,
  });
  return { quote, urls, written };
}

describe('swap BSV/USD quote', () => {
  test('a fresh cached rate is used without fetching', async () => {
    const s = setup({ rate: 40, timestamp: NOW - 1000 }, async () => json({ rate: 99 }));
    expect((await s.quote()).rate).toBe(40);
    expect(s.urls).toEqual([]);
  });
  test('no cache: fetched from WhatsOnChain and cached', async () => {
    const s = setup(undefined, async () => json({ rate: 41.5 }));
    const q = await s.quote();
    expect(q).toEqual({ rate: 41.5, source: 'WhatsOnChain BSV/USD rate' });
    expect(s.urls[0]).toContain('/exchangerate');
    expect(s.written).toEqual([{ rate: 41.5, timestamp: NOW }]);
  });
  test('a stale or untimestamped cache is refreshed', async () => {
    for (const c of [{ rate: 40, timestamp: NOW - SWAP_RATE_TTL_MS - 1 }, { rate: 40 }]) {
      const s = setup(c, async () => json({ rate: 42 }));
      expect((await s.quote()).rate).toBe(42);
    }
  });
  test('WhatsOnChain down: falls back to CoinGecko', async () => {
    const s = setup(undefined, async (u) =>
      u.includes('coingecko') ? json({ 'bitcoin-cash-sv': { usd: 43 } }) : json({}, false),
    );
    expect(await s.quote()).toEqual({ rate: 43, source: 'CoinGecko BSV/USD rate' });
  });
  test('a hanging source times out and the next is tried', async () => {
    const s2 = makeSwapQuote({
      readCache: async () => undefined,
      writeCache: async () => undefined,
      fetch: ((u: string, init?: RequestInit) =>
        u.includes('coingecko')
          ? Promise.resolve(json({ 'bitcoin-cash-sv': { usd: 44 } }))
          : new Promise<Response>((_, rej) =>
              init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))),
            )) as unknown as typeof fetch,
      timeoutMs: 20,
    });
    expect((await s2()).rate).toBe(44);
  });
  test('every source fails: clear error naming them, never "open the wallet"', async () => {
    const s = setup(undefined, async () => {
      throw new Error('offline');
    });
    const e = await s.quote().catch((x: Error) => x);
    expect((e as Error).message).toBe(
      "Couldn't get the BSV price (tried WhatsOnChain, CoinGecko). Check your connection and try again",
    );
    expect((e as Error).message).not.toMatch(/open the wallet/i);
  });
});
