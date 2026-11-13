import { describe, expect, test } from 'bun:test';
import sp from '../lib/sharedPrice.js';
import handler from '../api/price.js';

const { makeSharedPrice, parseMinute, plainMaxAge, keyedMaxAge, WOC_RATE_URL, MINUTE_MS, STALE_MAX_MS } = sp;
const M = 29_000_000 * MINUTE_MS; // a minute start
const iso = (ms) => new Date(ms).toISOString();

/** A fake WhatsOnChain: `rate`/`time` are read at call time; `down` makes it fail. */
function woc(start = { rate: 15.174, time: M / 1000 - 7 }) {
  const s = { ...start, calls: 0, urls: [], down: false };
  s.fetch = async (url) => {
    s.calls++;
    s.urls.push(url);
    if (s.down) return new Response('', { status: 404 });
    return new Response(JSON.stringify({ rate: s.rate, time: s.time, currency: 'USD' }), { status: 200 });
  };
  return s;
}

describe('minute bucketing', () => {
  test('parseMinute takes the current or previous minute, the next only in the last 5 s', () => {
    const now = M + 30_000;
    expect(parseMinute(iso(M), now)).toBe(M);
    expect(parseMinute(iso(M - MINUTE_MS), now)).toBe(M - MINUTE_MS);
    expect(parseMinute(iso(M - 2 * MINUTE_MS), now)).toBeNull();
    expect(parseMinute(iso(M + MINUTE_MS), now)).toBeNull(); // no pinning the next minute 30 s early
    expect(parseMinute(iso(M + MINUTE_MS), M + 55_000)).toBe(M + MINUTE_MS); // a device clock a few seconds fast
    expect(parseMinute(iso(M + MINUTE_MS), M + 54_999)).toBeNull();
    expect(parseMinute(iso(M + 2 * MINUTE_MS), M + 59_999)).toBeNull();
    expect(parseMinute(iso(M + 1000), now)).toBeNull(); // not a minute start
    expect(parseMinute('nonsense', now)).toBeNull();
    expect(parseMinute(null, now)).toBeNull();
  });

  test('one WhatsOnChain call per minute; every request in the minute gets the identical value', async () => {
    let now = M + 2_000;
    const w = woc();
    const price = makeSharedPrice({ fetch: w.fetch, now: () => now });
    const [s1, a] = await price(iso(M));
    expect(s1).toBe(200);
    expect(a).toEqual({
      bsvUsd: 15.17,
      minute: iso(M),
      source: 'whatsonchain',
      sourceTime: (M / 1000 - 7) * 1000,
      fetchedAt: iso(M + 2_000),
    });
    expect(w.urls).toEqual([WOC_RATE_URL]);
    w.rate = 15.29; // WoC moves within the minute
    now = M + 41_000;
    const [, b] = await price(iso(M));
    const [, c] = await price(null); // plain request, same server minute
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(w.calls).toBe(1);
    now = M + MINUTE_MS + 2_000; // next minute: a new reading
    const [, d] = await price(iso(M + MINUTE_MS));
    expect(d.bsvUsd).toBe(15.29);
    expect(d.minute).toBe(iso(M + MINUTE_MS));
    expect(w.calls).toBe(2);
    // a late device still asking for the previous minute gets that minute's value, not the new one
    const [, e] = await price(iso(M));
    expect(e).toEqual(a);
    expect(w.calls).toBe(2);
  });

  test('concurrent first requests share one WhatsOnChain call', async () => {
    const w = woc();
    const price = makeSharedPrice({ fetch: w.fetch, now: () => M + 5_000 });
    const rs = await Promise.all([price(iso(M)), price(iso(M)), price(null)]);
    expect(rs.map((r) => r[1].bsvUsd)).toEqual([15.17, 15.17, 15.17]);
    expect(w.calls).toBe(1);
  });

  test('a device whose clock is ahead gets the current reading for its minute, kept for that minute', async () => {
    let now = M + 59_000;
    const w = woc();
    const price = makeSharedPrice({ fetch: w.fetch, now: () => now });
    const [, ahead] = await price(iso(M + MINUTE_MS));
    w.rate = 16;
    now = M + MINUTE_MS + 30_000;
    const [, onTime] = await price(iso(M + MINUTE_MS));
    expect(onTime).toEqual(ahead);
  });
});

describe('cache header math', () => {
  test('plain: until 2 s after the next minute starts', () => {
    expect(plainMaxAge(M)).toBe(62);
    expect(plainMaxAge(M + 2_000)).toBe(60);
    expect(plainMaxAge(M + 59_000)).toBe(3);
    expect(plainMaxAge(M + 59_999)).toBe(3); // 1 ms rounds up to 1 s
    expect(plainMaxAge(M + 58_500)).toBe(4);
  });

  test('keyed: until a minute after the keyed minute ends', () => {
    expect(keyedMaxAge(M + 2_000, M)).toBe(120);
    expect(keyedMaxAge(M + 59_000, M + MINUTE_MS)).toBe(123);
    expect(keyedMaxAge(M + 3 * MINUTE_MS, M)).toBe(1); // never 0 or negative
  });

  test('headers per request kind', async () => {
    const w = woc();
    const price = makeSharedPrice({ fetch: w.fetch, now: () => M + 15_000 });
    expect((await price(null))[2]).toBe('public, max-age=0, s-maxage=47, stale-while-revalidate=30');
    expect((await price(iso(M)))[2]).toBe('public, max-age=0, s-maxage=107, stale-while-revalidate=30');
    expect((await price('2030-01-01T00:00:00.000Z'))[2]).toBe('no-store');
  });
});

describe('WhatsOnChain failure', () => {
  test('503 when there has never been a price', async () => {
    const w = woc();
    w.down = true;
    const price = makeSharedPrice({ fetch: w.fetch, now: () => M + 2_000 });
    expect(await price(iso(M))).toEqual([503, { error: 'price-unavailable' }, 'no-store']);
  });

  test('a thrown fetch (network/timeout) is a failure too', async () => {
    const price = makeSharedPrice({
      fetch: async () => {
        throw new Error('aborted');
      },
      now: () => M + 2_000,
    });
    expect((await price(null))[0]).toBe(503);
  });

  test('a bad rate is a failure, not a price', async () => {
    const w = woc({ rate: 'x' });
    const price = makeSharedPrice({ fetch: w.fetch, now: () => M + 2_000 });
    expect((await price(null))[0]).toBe(503);
  });

  test('a stale value older than 5 minutes is not served: 503', async () => {
    let now = M + 2_000;
    const w = woc();
    const price = makeSharedPrice({ fetch: w.fetch, now: () => now });
    await price(iso(M));
    w.down = true;
    now = M + 2_000 + STALE_MAX_MS; // exactly 5 min: still served, stale
    expect((await price(null))[1].stale).toBe(true);
    now += 10_001; // past 5 min (and past the retry wait)
    expect(await price(null)).toEqual([503, { error: 'price-unavailable' }, 'no-store']);
  });

  test('last good value, marked stale, cached 5 s, not memoised; retried after 10 s; heals', async () => {
    let now = M + 2_000;
    const w = woc();
    const price = makeSharedPrice({ fetch: w.fetch, now: () => now });
    const [, good] = await price(iso(M));
    w.down = true;
    now = M + MINUTE_MS + 2_000;
    const [status, body, cc] = await price(iso(M + MINUTE_MS));
    expect(status).toBe(200);
    expect(body).toEqual({ ...good, minute: iso(M + MINUTE_MS), stale: true });
    expect(cc).toBe('public, max-age=0, s-maxage=5');
    expect(w.calls).toBe(2);
    now += 5_000; // inside the retry wait: no new WoC call
    expect((await price(iso(M + MINUTE_MS)))[1].stale).toBe(true);
    expect(w.calls).toBe(2);
    w.down = false;
    w.rate = 15.5;
    now += 6_000;
    const [, healed] = await price(iso(M + MINUTE_MS));
    expect(healed.stale).toBeUndefined();
    expect(healed.bsvUsd).toBe(15.5);
    expect(w.calls).toBe(3);
  });
});

describe('handler', () => {
  const call = async (method, url) => {
    const headers = {};
    const res = {
      statusCode: 0,
      body: undefined,
      setHeader: (k, v) => (headers[k.toLowerCase()] = v),
      end: (b) => (res.body = b),
    };
    await handler({ method, url, headers: {} }, res);
    return { status: res.statusCode, headers, body: res.body === undefined ? undefined : JSON.parse(res.body) };
  };

  test('GET returns the price with CORS * and the cache header', async () => {
    const w = woc();
    handler.__setPriceForTests(makeSharedPrice({ fetch: w.fetch, now: () => M + 2_000 }));
    const r = await call('GET', `/api/price?m=${encodeURIComponent(iso(M))}`);
    expect(r.status).toBe(200);
    expect(r.body.bsvUsd).toBe(15.17);
    expect(r.body.minute).toBe(iso(M));
    expect(r.headers['access-control-allow-origin']).toBe('*');
    expect(r.headers['cache-control']).toBe('public, max-age=0, s-maxage=120, stale-while-revalidate=30');
    expect(r.headers['content-type']).toBe('application/json');
  });

  test('OPTIONS 204, POST 405, HEAD has no body', async () => {
    const w = woc();
    handler.__setPriceForTests(makeSharedPrice({ fetch: w.fetch, now: () => M + 2_000 }));
    expect((await call('OPTIONS', '/api/price')).status).toBe(204);
    const post = await call('POST', '/api/price');
    expect(post.status).toBe(405);
    expect(post.headers['cache-control']).toBe('no-store');
    const head = await call('HEAD', '/api/price');
    expect(head.status).toBe(200);
    expect(head.body).toBeUndefined();
  });

  test('unknown or repeated query parameters: 400, cacheable, no WoC call', async () => {
    const w = woc();
    handler.__setPriceForTests(makeSharedPrice({ fetch: w.fetch, now: () => M + 2_000 }));
    for (const url of ['/api/price?x=1', `/api/price?m=${encodeURIComponent(iso(M))}&cb=7`, '/api/price?m=a&m=b']) {
      const r = await call('GET', url);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: 'bad-query' });
      expect(r.headers['cache-control']).toBe('public, max-age=3600, s-maxage=86400');
    }
    expect(w.calls).toBe(0);
  });

  test('per-IP limit: 60 a minute, then 429 no-store', async () => {
    const w = woc();
    handler.__setPriceForTests(makeSharedPrice({ fetch: w.fetch, now: () => M + 2_000 }));
    for (let i = 0; i < 60; i++) expect((await call('GET', '/api/price')).status).toBe(200);
    const r = await call('GET', '/api/price');
    expect(r.status).toBe(429);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(w.calls).toBe(1);
  });

  test('503 passes through with no-store', async () => {
    const w = woc();
    w.down = true;
    handler.__setPriceForTests(makeSharedPrice({ fetch: w.fetch, now: () => M + 2_000 }));
    const r = await call('GET', '/api/price');
    expect(r.status).toBe(503);
    expect(r.headers['cache-control']).toBe('no-store');
  });
});
