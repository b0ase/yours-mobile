import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  __resetExchangeRateForTests,
  BACKOFF_MAX_MS,
  cachedExchangeRate,
  fetchExchangeRate,
  isExchangeRateStale,
  RATE_FETCH_OFFSET_MS,
  RATE_TTL_MS,
  STORAGE_KEY,
  exchangeRateAgeMs,
  msToNextRateBucket,
  rateBucket,
  subscribeExchangeRate,
} from './exchangeRate';

let now = 1_000_000;
let calls = 0;
let next: () => Response;
const mem = new Map<string, string>();
const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
const ok = (rate: number, time?: number) => () =>
  new Response(JSON.stringify(time === undefined ? { rate } : { rate, time }), { status: 200 });
const tooMany = () => new Response('', { status: 429 });

// bun runs every test file in one process and this module keeps the price in memory: don't hand the next file a
// cached $ rate (it turned "1.5 BSV" into "$105.00" in notify.test.ts), a fake fetch or a frozen clock.
afterAll(() => __resetExchangeRateForTests({ fetch: (...a) => fetch(...a), now: () => Date.now(), storage: null }));

beforeEach(() => {
  now = 1_000_000;
  calls = 0;
  mem.clear();
  next = ok(50);
  __resetExchangeRateForTests({
    now: () => now,
    storage,
    fetch: (async () => {
      calls++;
      return next();
    }) as unknown as typeof fetch,
  });
});

describe('exchange rate', () => {
  test('dedupes concurrent callers into one request', async () => {
    const rs = await Promise.all([fetchExchangeRate('main'), fetchExchangeRate('main'), fetchExchangeRate('main')]);
    expect(rs).toEqual([50, 50, 50]);
    expect(calls).toBe(1);
  });

  test('reuses the price within its minute and refetches after', async () => {
    now = 17 * RATE_TTL_MS + RATE_FETCH_OFFSET_MS; // the first moment of a window
    await fetchExchangeRate('main');
    now += RATE_TTL_MS - 1;
    expect(await fetchExchangeRate('main')).toBe(50);
    expect(calls).toBe(1);
    expect(isExchangeRateStale()).toBe(false);
    now += 1;
    expect(isExchangeRateStale()).toBe(true);
    next = ok(60);
    expect(await fetchExchangeRate('main')).toBe(60);
    expect(calls).toBe(2);
  });

  test('persists last known price and serves it after restart', async () => {
    await fetchExchangeRate('main');
    expect(JSON.parse(mem.get(STORAGE_KEY)!)).toEqual({ rate: 50, timestamp: 1_000_000 });
    __resetExchangeRateForTests();
    expect(cachedExchangeRate()).toBe(50);
  });

  test('backs off 2 → 4 → 8 min on 429, capped, and keeps the stale price', async () => {
    await fetchExchangeRate('main');
    next = tooMany;
    now += RATE_TTL_MS;
    expect(await fetchExchangeRate('main')).toBe(50); // fails, stale price
    expect(calls).toBe(2);
    const step = async (wait: number) => {
      now += wait - 1;
      expect(await fetchExchangeRate('main')).toBe(50);
      const before = calls;
      now += 1;
      await fetchExchangeRate('main');
      expect(calls).toBe(before + 1);
      expect(calls - before).toBe(1);
    };
    const before = calls;
    now += 2 * 60_000 - 1;
    await fetchExchangeRate('main');
    expect(calls).toBe(before); // still waiting
    now += 1;
    await fetchExchangeRate('main');
    expect(calls).toBe(before + 1);
    await step(4 * 60_000);
    await step(8 * 60_000);
    await step(BACKOFF_MAX_MS); // 16 min capped to 15
    expect(isExchangeRateStale()).toBe(true);
    next = ok(70);
    now += BACKOFF_MAX_MS;
    expect(await fetchExchangeRate('main')).toBe(70);
  });

  test('network failure with no price returns 0 without throwing', async () => {
    next = () => {
      throw new Error('offline');
    };
    expect(await fetchExchangeRate('main')).toBe(0);
  });
});

describe('the same price on every device (owner, 13 Nov 2026: extension and iPhone one cent apart)', () => {
  const W = 1_000 * RATE_TTL_MS + RATE_FETCH_OFFSET_MS; // a window's first moment

  test('a price belongs to a wall-clock window, not to when this device asked', async () => {
    // Device A asks at the window's start, device B 50 s later: both drop it at the same moment.
    expect(rateBucket(W)).toBe(rateBucket(W + RATE_TTL_MS - 1));
    expect(rateBucket(W + RATE_TTL_MS)).toBe(rateBucket(W) + 1);
    expect(msToNextRateBucket(W)).toBe(RATE_TTL_MS);
    expect(msToNextRateBucket(W + 50_000)).toBe(RATE_TTL_MS - 50_000);
    expect(msToNextRateBucket(W - 1)).toBe(1);

    now = W + 50_000;
    await fetchExchangeRate('main');
    now = W + RATE_TTL_MS - 1;
    expect(isExchangeRateStale()).toBe(false);
    now = W + RATE_TTL_MS; // 10 s after B asked, but a new window: stale on every device at once
    expect(isExchangeRateStale()).toBe(true);
  });

  test('the same answers give the same price; the selection never depends on fetch order or timing', async () => {
    const seen: number[] = [];
    for (const at of [W + 1, W + 30_000, W + 59_000]) {
      __resetExchangeRateForTests({
        now: () => now,
        storage: { getItem: () => null, setItem: () => undefined },
        fetch: (async () => ok(15.1745)()) as unknown as typeof fetch,
      });
      now = at;
      seen.push(await fetchExchangeRate('main'));
    }
    expect(seen).toEqual([15.17, 15.17, 15.17]);
  });

  test("keeps WhatsOnChain's own time for the price age, and tells listeners about a new price", async () => {
    now = W + 5_000;
    next = ok(15.17, Math.floor((W - 20_000) / 1000));
    let told = 0;
    const off = subscribeExchangeRate(() => told++);
    await fetchExchangeRate('main');
    off();
    expect(told).toBe(1);
    expect(exchangeRateAgeMs(W + 5_000)).toBe(25_000);
    expect(JSON.parse(mem.get(STORAGE_KEY)!).sourceTime).toBe(Math.floor((W - 20_000) / 1000) * 1000);
  });
});
