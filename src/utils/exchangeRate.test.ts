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
  lastKnownExchangeRate,
  cachedDisplayRate,
  fetchDisplayRate,
  rateBucket,
  sharedPriceUrl,
  subscribeExchangeRate,
  WOC_REF_KEY,
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
afterAll(() =>
  __resetExchangeRateForTests({
    fetch: (...a) => fetch(...a),
    now: () => Date.now(),
    storage: null,
    sharedBase: '',
    timeouts: { shared: 4_000, woc: 6_000 },
  }),
);

beforeEach(() => {
  now = 1_000_000;
  calls = 0;
  mem.clear();
  next = ok(50);
  __resetExchangeRateForTests({
    now: () => now,
    storage,
    sharedBase: '',
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
    expect(JSON.parse(mem.get(STORAGE_KEY)!)).toEqual({ rate: 50, timestamp: 1_000_000, source: 'woc' });
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

describe('one shared price per minute (owner, 13 Nov 2026)', () => {
  const BASE = 'https://pay.example';
  const W = 29_000_000 * RATE_TTL_MS + RATE_FETCH_OFFSET_MS; // a window's first moment
  const MINUTE = new Date(W - RATE_FETCH_OFFSET_MS).toISOString();
  const WOC = 'https://api.whatsonchain.com/v1/bsv/main/exchangerate';
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  const fresh = () => new Map<string, string>();

  /**
   * A fake world: `cdn` stands in for Vercel's CDN in front of /api/price (the URL is the cache key, the first answer
   * for a URL is kept), `woc` is WhatsOnChain's current rate. `serverDown` / `wocDown` break either side.
   */
  function world() {
    const w = {
      woc: 15.174,
      wocTime: Math.floor((W - 9_000) / 1000),
      serverDown: false,
      wocDown: false,
      cdn: new Map<string, unknown>(),
      urls: [] as string[],
      server: (url: string): unknown => ({
        bsvUsd: Number(w.woc.toFixed(2)),
        minute: new URL(url).searchParams.get('m'),
        source: 'whatsonchain',
        sourceTime: w.wocTime * 1000,
        fetchedAt: new Date(now).toISOString(),
      }),
      fetch: (async (input: RequestInfo | URL) => {
        const url = String(input);
        w.urls.push(url);
        if (url.startsWith(BASE)) {
          if (w.serverDown) return new Response('', { status: 503 });
          if (!w.cdn.has(url)) w.cdn.set(url, w.server(url));
          return json(w.cdn.get(url));
        }
        if (url.startsWith(WOC)) {
          if (w.wocDown) return new Response('', { status: 429 });
          return json({ rate: w.woc, time: w.wocTime });
        }
        throw new Error(`unexpected ${url}`);
      }) as unknown as typeof fetch,
    };
    return w;
  }
  const wocCalls = (w: ReturnType<typeof world>) => w.urls.filter((u) => u === WOC).length;
  /** A device: own memory, own storage (pass one to keep it across "restarts"), same world. */
  const device = (w: ReturnType<typeof world>, mem2 = fresh()) => {
    __resetExchangeRateForTests({
      now: () => now,
      sharedBase: BASE,
      fetch: w.fetch,
      timeouts: { shared: 4_000, woc: 6_000 },
      storage: { getItem: (k) => mem2.get(k) ?? null, setItem: (k, v) => void mem2.set(k, v) },
    });
    return mem2;
  };

  test("the URL is keyed by the window's wall-clock minute", () => {
    expect(sharedPriceUrl(BASE, W)).toBe(`${BASE}/api/price?m=${encodeURIComponent(MINUTE)}`);
    expect(sharedPriceUrl(`${BASE}/`, W + RATE_TTL_MS - 1)).toBe(sharedPriceUrl(BASE, W));
    expect(sharedPriceUrl(BASE, W + RATE_TTL_MS)).not.toBe(sharedPriceUrl(BASE, W));
  });

  test('display uses the shared endpoint and records the source; a device with no WoC price asks WoC once', async () => {
    const w = world();
    device(w);
    now = W + 1_000;
    expect(await fetchDisplayRate('main')).toBe(15.17);
    expect(w.urls).toEqual([sharedPriceUrl(BASE, W), WOC]);
    expect(cachedDisplayRate()).toBe(15.17);
    expect(exchangeRateAgeMs(W + 1_000)).toBe(W + 1_000 - Math.floor((W - 9_000) / 1000) * 1000);
    // next minute: the WoC reference is young and agrees, so only the shared endpoint is asked
    now = W + RATE_TTL_MS + 1_000;
    await fetchDisplayRate('main');
    expect(wocCalls(w)).toBe(1);
    expect(w.urls.at(-1)).toBe(sharedPriceUrl(BASE, W + RATE_TTL_MS));
  });

  test('two devices in the same minute get the identical value even when WhatsOnChain moved in between', async () => {
    const w = world();
    device(w);
    now = W + 500; // the extension
    const a = await fetchDisplayRate('main');
    const pa = await fetchExchangeRate('main');
    w.woc = 15.25; // WoC ticks
    device(w); // the iPhone: its own memory and storage
    now = W + 45_000;
    const b = await fetchDisplayRate('main');
    const pb = await fetchExchangeRate('main');
    expect(a).toBe(15.17);
    expect(b).toBe(a);
    // the payment rate is the same cent too while the shared price agrees with WoC within 2%
    expect(pa).toBe(15.17);
    expect(pb).toBe(15.17);
    // next minute: both move together
    now = W + RATE_TTL_MS + 100;
    expect(await fetchDisplayRate('main')).toBe(15.25);
  });

  test('falls back to WhatsOnChain when the shared endpoint fails', async () => {
    const w = world();
    w.serverDown = true;
    device(w);
    now = W + 1_000;
    expect(await fetchDisplayRate('main')).toBe(15.17);
    expect(w.urls).toEqual([sharedPriceUrl(BASE, W), WOC]);
    expect(lastKnownExchangeRate()!.source).toBe('woc');
  });

  test('falls back to WhatsOnChain when the shared endpoint throws or sends junk, or a price out of bounds', async () => {
    for (const bad of [
      () => {
        throw new Error('offline');
      },
      () => json({ bsvUsd: 'NaN' }),
      () => json({ bsvUsd: -1 }),
      () => json({ bsvUsd: 0.001 }), // under the $0.01 floor
      () => json({ bsvUsd: 1_000_000 }), // over the $100,000 ceiling
      () => new Response('<html>', { status: 200 }),
    ]) {
      const w = world();
      const inner = w.fetch;
      w.fetch = (async (input: RequestInfo | URL) =>
        String(input).startsWith(BASE) ? bad() : inner(input)) as unknown as typeof fetch;
      device(w);
      now = W + 1_000;
      expect(await fetchDisplayRate('main')).toBe(15.17);
      expect(lastKnownExchangeRate()!.source).toBe('woc');
    }
  });

  test('walk-down: a shared feed falling 19% a minute never moves the payment rate', async () => {
    const w = world();
    w.woc = 50;
    const mem2 = device(w);
    now = W + 1_000;
    let shared = 50;
    w.server = (url) => ({ bsvUsd: shared, minute: new URL(url).searchParams.get('m'), source: 'whatsonchain' });
    const display: number[] = [];
    const pay: number[] = [];
    for (let k = 0; k < 10; k++) {
      display.push(await fetchDisplayRate('main'));
      pay.push(await fetchExchangeRate('main'));
      // a restart now and then: the reference survives in storage
      if (k === 4) device(w, mem2);
      shared = Number((shared * 0.81).toFixed(2));
      now += RATE_TTL_MS;
    }
    expect(shared).toBeLessThan(7); // the feed walked from $50 to ~$6
    expect(pay).toEqual(Array(10).fill(50));
    expect(Math.min(...display)).toBeGreaterThanOrEqual(50 * 0.8); // the display never follows it out of the band
    expect(cachedExchangeRate()).toBe(50);
    expect(JSON.parse(mem2.get(WOC_REF_KEY)!).rate).toBe(50); // only WhatsOnChain sets the reference
    expect(wocCalls(w)).toBeGreaterThan(1); // the drift made the wallet re-read WhatsOnChain
  });

  test('payment rate: the display price only within 2% of WhatsOnChain', async () => {
    const w = world();
    w.woc = 50;
    w.server = (url) => ({ bsvUsd: 48.9, minute: new URL(url).searchParams.get('m'), source: 'whatsonchain' });
    device(w);
    now = W + 1_000;
    expect(await fetchDisplayRate('main')).toBe(48.9); // within the display band
    expect(await fetchExchangeRate('main')).toBe(50); // 2.2% off WoC: WoC's rate
    expect(lastKnownExchangeRate()!.source).toBe('woc');
    w.server = (url) => ({ bsvUsd: 49.1, minute: new URL(url).searchParams.get('m'), source: 'whatsonchain' });
    now += RATE_TTL_MS;
    expect(await fetchExchangeRate('main')).toBe(49.1); // 1.8%: the same cent as the display
  });

  test('fresh install: a wild shared price is checked against WhatsOnChain before anything takes it', async () => {
    const w = world();
    w.woc = 50;
    w.server = (url) => ({ bsvUsd: 0.5, minute: new URL(url).searchParams.get('m'), source: 'whatsonchain' });
    device(w);
    now = W + 1_000;
    expect(await fetchDisplayRate('main')).toBe(50);
    expect(cachedDisplayRate()).toBe(50);
    expect(await fetchExchangeRate('main')).toBe(50);
    expect(wocCalls(w)).toBe(1);
  });

  test('a reference older than 24 h is re-read before a shared price is taken', async () => {
    const w = world();
    w.woc = 50;
    const mem2 = fresh();
    mem2.set(WOC_REF_KEY, JSON.stringify({ rate: 10, at: W - 25 * 60 * 60_000 }));
    device(w, mem2);
    now = W + 1_000;
    expect(await fetchDisplayRate('main')).toBe(50);
    expect(wocCalls(w)).toBe(1);
  });

  test('fresh install with WhatsOnChain down: the shared price is shown, but the payment rate stays 0', async () => {
    const w = world();
    w.wocDown = true;
    device(w);
    now = W + 1_000;
    expect(await fetchDisplayRate('main')).toBe(15.17);
    expect(await fetchExchangeRate('main')).toBe(0);
    expect(cachedExchangeRate()).toBe(0);
    expect(lastKnownExchangeRate()).toBeNull();
  });

  test('a price stored before the shared endpoint seeds the WhatsOnChain reference', async () => {
    const w = world();
    w.serverDown = true;
    w.wocDown = true;
    const mem2 = fresh();
    mem2.set(STORAGE_KEY, JSON.stringify({ rate: 15.1, timestamp: W - 30_000 }));
    device(w, mem2);
    expect(cachedExchangeRate()).toBe(15.1);
  });

  test('a stale shared value: WhatsOnChain is asked; used only if WoC fails too, newer than ours, at its real age', async () => {
    const stale = (bsvUsd: number, sourceTime: number) => (url: string) => ({
      bsvUsd,
      minute: new URL(url).searchParams.get('m'),
      sourceTime,
      stale: true,
    });
    const w = world();
    w.server = stale(14.9, W - 120_000);
    device(w);
    now = W + 1_000;
    expect(await fetchDisplayRate('main')).toBe(15.17);
    expect(lastKnownExchangeRate()!.source).toBe('woc');

    const w2 = world();
    w2.server = stale(14.9, W - 120_000);
    w2.wocDown = true;
    device(w2);
    expect(await fetchDisplayRate('main')).toBe(14.9);
    expect(exchangeRateAgeMs(W + 1_000)).toBe(121_000); // its real age, not stamped "now"
    expect(cachedExchangeRate()).toBe(0); // no WhatsOnChain price: nothing to pay with

    // older than what this device already holds: ignored
    const w3 = world();
    w3.server = stale(14.9, W - 600_000);
    w3.wocDown = true;
    const mem3 = fresh();
    mem3.set(STORAGE_KEY, JSON.stringify({ rate: 15.3, timestamp: W - 300_000, source: 'woc' }));
    device(w3, mem3);
    expect(await fetchDisplayRate('main')).toBe(15.3);
    // and none without a source time
    const w4 = world();
    w4.server = (url) => ({ bsvUsd: 14.9, minute: new URL(url).searchParams.get('m'), stale: true });
    w4.wocDown = true;
    device(w4);
    expect(await fetchDisplayRate('main')).toBe(0);
  });

  test('a hung WhatsOnChain request is dropped after its timeout', async () => {
    const hang = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    __resetExchangeRateForTests({
      now: () => now,
      sharedBase: '',
      fetch: hang,
      timeouts: { shared: 20, woc: 20 },
      storage: { getItem: () => null, setItem: () => undefined },
    });
    now = W + 1_000;
    const started = Date.now();
    expect(await fetchExchangeRate('main')).toBe(0);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('both down: the last known price, and the usual back-off', async () => {
    const w = world();
    const mem2 = device(w);
    now = W + 1_000;
    await fetchExchangeRate('main');
    w.serverDown = true;
    w.wocDown = true;
    now = W + RATE_TTL_MS + 1_000;
    expect(await fetchExchangeRate('main')).toBe(15.17);
    const n = w.urls.length;
    now += 60_000; // inside the 2-minute back-off
    expect(await fetchExchangeRate('main')).toBe(15.17);
    expect(w.urls.length).toBe(n);
    expect(mem2.size).toBe(2);
  });

  test('no endpoint configured (unit tests, builds without the Store API): WhatsOnChain only', async () => {
    const w = world();
    device(w);
    __resetExchangeRateForTests({ sharedBase: '' });
    now = W + 1_000;
    expect(await fetchExchangeRate('main')).toBe(15.17);
    expect(w.urls).toEqual([WOC]);
  });
});
