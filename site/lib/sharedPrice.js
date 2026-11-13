// One shared BSV/USD price per minute for every bWalletX device (owner, 13 Nov 2026: "one shared price per minute",
// so the extension and the iPhone show the same cent). GET /api/price[?m=<ISO minute start>].
//
// Each device used to ask WhatsOnChain itself. WoC's rate moves every ~20 s, so two devices asking a few seconds apart
// could read different ticks and show balances a cent apart. Now the wallet asks this endpoint, keyed by the wall-clock
// minute it is in (?m=2026-11-13T15:04:00.000Z, see src/utils/exchangeRate.ts sharedPriceUrl). The first request for a
// minute fixes that minute's value in this instance (memo) and in Vercel's CDN (the URL is the cache key), so every
// later request for the same minute gets the identical number.
//
// - WhatsOnChain is asked at most once per server minute per instance (a failure may be retried after RETRY_MS).
// - The rate is rounded to 2 dp exactly like the wallet did (Number(rate.toFixed(2))).
// - WoC failure: the last good value is returned with `stale: true` and a 5 s cache (so it heals quickly), or a 503
//   when this instance has never had one.
// - Without ?m (or with an m too far from the server clock) the answer is for the server's current minute; a plain
//   /api/price is cached until 2 s after the next minute starts, with stale-while-revalidate=30 (owner's spec).
// - No secrets, no writes. CORS is `*` on purpose: the data is public and read without credentials, and echoing the
//   caller's origin would need `Vary: Origin`, which splits the CDN cache per origin, so the extension
//   (chrome-extension://…) and the iPhone (capacitor://localhost) could be handed different values for the same minute.
'use strict';

const WOC_RATE_URL = 'https://api.whatsonchain.com/v1/bsv/main/exchangerate';
const MINUTE_MS = 60_000;
/** The wallet asks 2 s into each minute (src/utils/exchangeRate.ts RATE_FETCH_OFFSET_MS); a plain response lives until then. */
const OFFSET_S = 2;
const RETRY_MS = 10_000;
const TIMEOUT_MS = 4_000;
const STALE_S = 5;
/** How far a requested minute may be from the server's (device clocks drift): 2 minutes back, 1 ahead. */
const MAX_BEHIND = 2;
const MAX_AHEAD = 1;
const MEMO_KEEP = 6;

const minuteStart = (ms) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;
/** Seconds until 2 s after the next minute starts (the CDN max age for a plain /api/price), at least 1. */
const plainMaxAge = (now) => Math.max(1, Math.ceil((minuteStart(now) + MINUTE_MS - now) / 1000) + OFFSET_S);
/**
 * Max age for a keyed /api/price?m=: until a minute after that minute's window ends. The key names one minute, so a long
 * life costs nothing, and a late device (clock behind) still gets the same value instead of a fresh fetch.
 */
const keyedMaxAge = (now, minute) => Math.max(1, Math.ceil((minute + 2 * MINUTE_MS - now) / 1000) + OFFSET_S);

/** The requested minute (ms) when `m` is an exact minute start near the server clock, else null. */
function parseMinute(m, now) {
  if (typeof m !== 'string' || !m) return null;
  const ms = Date.parse(m);
  if (!Number.isFinite(ms) || ms % MINUTE_MS !== 0) return null;
  const cur = minuteStart(now);
  if (ms < cur - MAX_BEHIND * MINUTE_MS || ms > cur + MAX_AHEAD * MINUTE_MS) return null;
  return ms;
}

function makeSharedPrice({ fetch: f = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  /** minute (ms) → the entry served for it. */
  const byMinute = new Map();
  /** Last good WoC reading: { bsvUsd, sourceTime?, fetchedAt (ms) }. */
  let last = null;
  let lastFailAt = -Infinity;
  let inFlight = null;

  async function askWoc() {
    const ctl = typeof AbortController === 'undefined' ? null : new AbortController();
    const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
    try {
      const res = await f(WOC_RATE_URL, ctl ? { signal: ctl.signal } : undefined);
      if (!res.ok) throw new Error(`whatsonchain ${res.status}`);
      const body = await res.json();
      const bsvUsd = Number(Number(body && body.rate).toFixed(2));
      if (!Number.isFinite(bsvUsd) || bsvUsd <= 0) throw new Error('bad rate');
      const t = Number(body && body.time);
      return { bsvUsd, ...(Number.isFinite(t) && t > 0 ? { sourceTime: t * 1000 } : {}), fetchedAt: now() };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** A good reading from this server minute, fetching WoC when there is none; null when WoC fails. */
  async function reading() {
    const t = now();
    if (last && minuteStart(last.fetchedAt) === minuteStart(t)) return last;
    if (t - lastFailAt < RETRY_MS) return null;
    if (!inFlight)
      inFlight = askWoc()
        .then((r) => (last = r))
        .catch(() => {
          lastFailAt = now();
          return null;
        })
        .finally(() => {
          inFlight = null;
        });
    return inFlight;
  }

  const shape = (r, minute, stale) => ({
    bsvUsd: r.bsvUsd,
    minute: new Date(minute).toISOString(),
    source: 'whatsonchain',
    sourceTime: r.sourceTime ?? null,
    fetchedAt: new Date(r.fetchedAt).toISOString(),
    ...(stale ? { stale: true } : {}),
  });

  /** Returns [status, body, cacheControl]. */
  return async function price(m) {
    const t = now();
    const keyed = parseMinute(m, t);
    const minute = keyed ?? minuteStart(t);
    const cacheOk =
      keyed !== null
        ? `public, max-age=0, s-maxage=${keyedMaxAge(t, minute)}, stale-while-revalidate=30`
        : m
          ? 'no-store' // an unusable ?m=: answer, but don't let a junk URL become a cache entry
          : `public, max-age=0, s-maxage=${plainMaxAge(t)}, stale-while-revalidate=30`;
    const memo = byMinute.get(minute);
    if (memo) return [200, memo, cacheOk];
    const r = await reading();
    if (r) {
      const body = shape(r, minute, false);
      byMinute.set(minute, body);
      while (byMinute.size > MEMO_KEEP) byMinute.delete(byMinute.keys().next().value);
      return [200, body, cacheOk];
    }
    if (last) return [200, shape(last, minute, true), `public, max-age=0, s-maxage=${STALE_S}`];
    return [503, { error: 'price-unavailable' }, 'no-store'];
  };
}

module.exports = { makeSharedPrice, parseMinute, plainMaxAge, keyedMaxAge, minuteStart, WOC_RATE_URL, MINUTE_MS };
