/**
 * One shared BSV/USD price for the whole app (owner, 16 Oct 2026: WhatsOnChain answered 429 on the iPhone because
 * every screen fetched the price on its own; a 429 carries no CORS header, so it showed as a CORS error).
 *
 * - one in-flight request at a time: callers that ask together share it;
 * - a fresh price is reused until its wall-clock minute ends (rateBucket);
 * - the last known price is kept in localStorage with its timestamp, so a restart starts with a price;
 * - on a 429 or a network failure we wait 2, 4, 8 … minutes (capped at 15) before asking again;
 * - callers always get the last known price (marked stale) instead of nothing.
 *
 * Same price on every device (owner, 13 Nov 2026: the extension and the iPhone showed the same balance one cent apart).
 * Each device used to keep a price for 60 s from whenever IT last asked, so two devices held prices up to a minute (and,
 * on a screen that only refreshed on a balance load, much more) apart; at ~9.5M sats a 0.7% move is a cent. Now a price
 * belongs to a wall-clock minute (rateBucket): every device drops it at the same moment, and the wallet screens ask again
 * RATE_FETCH_OFFSET_MS into each minute (startAlignedRateRefresh). The balance is turned into cents by one function on
 * every build (utils/balanceUsd.ts).
 *
 * One shared price per minute (owner, 13 Nov 2026): reading WhatsOnChain at the same moment still let two devices land
 * on either side of a WoC tick (~20 s). So the wallet first asks our own server (pay.bwallet.space GET
 * /api/price?m=<minute>, site/lib/sharedPrice.js), keyed by this window's wall-clock minute: the first request for a
 * minute fixes its value and every device asking for that minute gets the identical number.
 *
 * Two rates (review of the shared price, 13 Nov 2026). The price also turns USD amounts into sats for payments (bMail
 * price-to-reach, names, OpNS, credits, calls, pots…), and a LOWER rate pays MORE sats, so our server's number must
 * never be what the wallet pays with unchecked:
 *  - the DISPLAY rate (fetchDisplayRate / cachedDisplayRate): the shared per-minute price, for the balance headline and
 *    the price tile, so every device shows the same cent. It is taken only while within SHARED_BAND of WhatsOnChain;
 *  - the PAYMENT rate (fetchExchangeRate / cachedExchangeRate / lastKnownExchangeRate, the names every other caller
 *    already used, so anything not marked as display is payment-safe): the display rate while it agrees with
 *    WhatsOnChain within PAYMENT_TOLERANCE, else WhatsOnChain's own rate; 0 when this device has never had a WoC price.
 * WhatsOnChain is the independent reference (wocRef): only a direct WoC reading ever sets it, it is refreshed every
 * WOC_REF_MAX_AGE_MS for payments, whenever the shared price moves more than SHARED_RECHECK from it, and once on a
 * device that has none (or only one older than WOC_REF_BAND_MAX_AGE_MS). So a shared feed that walks the price down a
 * little every minute moves neither the reference nor the payment rate.
 */
import { WOC_MAINNET_URL } from '@1sat/actions';
import { BWALLET_PAYMAIL_API } from '../mobile/names/config';

export const RATE_TTL_MS = 60_000;
export const BACKOFF_START_MS = 2 * 60_000;
export const BACKOFF_MAX_MS = 15 * 60_000;
export const STORAGE_KEY = 'bwx.exchangeRate.v1';
/** The WhatsOnChain reference (WocRef), stored apart from the display price. */
export const WOC_REF_KEY = 'bwx.exchangeRate.woc.v1';
/** Into each minute, the moment the wallet screens ask for the price (every device the same moment). */
export const RATE_FETCH_OFFSET_MS = 2_000;
/** How long the shared endpoint / WhatsOnChain get before the request is dropped (a hung fetch blocks payments). */
export const SHARED_TIMEOUT_MS = 4_000;
export const WOC_TIMEOUT_MS = 6_000;
/** No price outside these is ever taken, from anyone (USD per BSV). */
export const RATE_FLOOR = 0.01;
export const RATE_CEILING = 100_000;
/** The display rate takes a shared price only within this band of the WhatsOnChain reference. */
export const SHARED_BAND = { low: 0.8, high: 1.25 };
/** A reference older than this doesn't count: WhatsOnChain is asked again before a shared price is taken. */
export const WOC_REF_BAND_MAX_AGE_MS = 24 * 60 * 60_000;
/** A shared price this far (fraction) from the reference makes the wallet re-read WhatsOnChain. */
export const SHARED_RECHECK = 0.05;
/** The payment rate re-reads WhatsOnChain when the reference is older than this. */
export const WOC_REF_MAX_AGE_MS = 10 * 60_000;
/** The payment rate uses the display rate only within this fraction of WhatsOnChain; else WhatsOnChain's rate. */
export const PAYMENT_TOLERANCE = 0.02;
/** At most one WhatsOnChain request per this long. */
export const WOC_MIN_GAP_MS = 60_000;

/**
 * `timestamp`: when this device fetched it (for a stale shared value: its source time). `sourceTime`: WhatsOnChain's own
 * time for the price (ms), when known. `source`: 'shared' = our per-minute endpoint, 'woc' = WhatsOnChain asked directly
 * (absent on prices stored before the shared endpoint; those all came from WhatsOnChain).
 */
export type RateEntry = { rate: number; timestamp: number; sourceTime?: number; source?: 'shared' | 'woc' };
/** A direct WhatsOnChain reading: `at` = when this device fetched it. */
export type WocRef = { rate: number; at: number; sourceTime?: number };

/** The wall-clock window a price belongs to: RATE_TTL_MS long, starting RATE_FETCH_OFFSET_MS into each minute. */
export const rateBucket = (ms: number): number => Math.floor((ms - RATE_FETCH_OFFSET_MS) / RATE_TTL_MS);
/** Milliseconds from `now` until the next window starts (always > 0). */
export const msToNextRateBucket = (now: number): number =>
  (rateBucket(now) + 1) * RATE_TTL_MS + RATE_FETCH_OFFSET_MS - now;
const fresh = (c: RateEntry | null, now: number): boolean => !!c && rateBucket(c.timestamp) === rateBucket(now);

/** The shared price URL for the window `now` is in: keyed by that window's wall-clock minute start (ISO). */
export const sharedPriceUrl = (base: string, now: number): string =>
  `${base.replace(/\/$/, '')}/api/price?m=${encodeURIComponent(new Date(rateBucket(now) * RATE_TTL_MS).toISOString())}`;

type Deps = {
  fetch: typeof fetch;
  now: () => number;
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** Base URL of the shared price endpoint (the Store/paymail API, pay.bwallet.space); '' = ask WhatsOnChain only. */
  sharedBase: string;
  timeouts: { shared: number; woc: number };
};

const defaultStorage = (): Deps['storage'] => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

let deps: Deps = {
  fetch: (...a) => fetch(...a),
  now: () => Date.now(),
  storage: defaultStorage(),
  sharedBase: BWALLET_PAYMAIL_API,
  timeouts: { shared: SHARED_TIMEOUT_MS, woc: WOC_TIMEOUT_MS },
};

let cache: RateEntry | null = null;
let wocRef: WocRef | null = null;
let loaded = false;
let inFlight: Promise<number> | null = null;
let failures = 0;
let retryAt = 0;
let wocInFlight: Promise<WocRef | null> | null = null;
let wocAttemptAt = -Infinity;
let wocFailures = 0;
let wocRetryAt = 0;

const inBounds = (r: number) => Number.isFinite(r) && r >= RATE_FLOOR && r <= RATE_CEILING;
const drift = (a: number, b: number) => Math.abs(a / b - 1);
const inBand = (a: number, b: number) => a / b >= SHARED_BAND.low && a / b <= SHARED_BAND.high;
const backoff = (n: number) => Math.min(BACKOFF_START_MS * 2 ** (n - 1), BACKOFF_MAX_MS);

function read<T>(key: string, ok: (v: T) => boolean): T | null {
  try {
    const raw = deps.storage?.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as T;
    return v && ok(v) ? v : null;
  } catch {
    return null;
  }
}

function load(): RateEntry | null {
  if (loaded) return cache;
  loaded = true;
  cache = read<RateEntry>(STORAGE_KEY, (v) => inBounds(v.rate) && Number.isFinite(v.timestamp));
  wocRef = read<WocRef>(WOC_REF_KEY, (v) => inBounds(v.rate) && Number.isFinite(v.at));
  // A price stored before the shared endpoint (no source) came from WhatsOnChain: it seeds the reference.
  if (!wocRef && cache && (cache.source ?? 'woc') === 'woc')
    wocRef = { rate: cache.rate, at: cache.timestamp, ...(cache.sourceTime ? { sourceTime: cache.sourceTime } : {}) };
  return cache;
}
const loadRef = (): WocRef | null => (load(), wocRef);

const listeners = new Set<() => void>();
/** Called whenever a new display price is stored (any screen's fetch); returns the unsubscribe. */
export const subscribeExchangeRate = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};

function store(key: string, v: unknown, notify: boolean) {
  try {
    deps.storage?.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
  if (!notify) return;
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch {
      /* a listener's failure is its own */
    }
  }
}

function save(entry: RateEntry) {
  cache = entry;
  store(STORAGE_KEY, entry, true);
}

function fail() {
  failures += 1;
  retryAt = deps.now() + backoff(failures);
}

const toRate = (v: unknown): number => {
  const rate = Number(Number(v).toFixed(2));
  if (!inBounds(rate)) throw new Error('bad rate');
  return rate;
};

async function withTimeout(url: string, ms: number, init: RequestInit = {}): Promise<Response> {
  const ctl = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = ctl ? setTimeout(() => ctl.abort(), ms) : undefined;
  try {
    return await deps.fetch(url, ctl ? { ...init, signal: ctl.signal } : init);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type Reading = { rate: number; sourceTime?: number };

/** The shared per-minute price, or null (no endpoint, failure, timeout, junk). `stale`: the server said so. */
async function askShared(now: number): Promise<(Reading & { stale: boolean }) | null> {
  if (!deps.sharedBase) return null;
  try {
    const res = await withTimeout(sharedPriceUrl(deps.sharedBase, now), deps.timeouts.shared);
    if (!res.ok) return null;
    const body = (await res.json()) as { bsvUsd?: unknown; sourceTime?: unknown; stale?: unknown } | null;
    const rate = toRate(body?.bsvUsd);
    const t = Number(body?.sourceTime);
    return { rate, ...(Number.isFinite(t) && t > 0 ? { sourceTime: t } : {}), stale: body?.stale === true };
  } catch {
    return null;
  }
}

async function askWoc(wocApiKey?: string): Promise<Reading> {
  const headers: Record<string, string> = {};
  if (wocApiKey) headers['woc-api-key'] = wocApiKey;
  const res = await withTimeout(`${WOC_MAINNET_URL}/exchangerate`, deps.timeouts.woc, { headers });
  if (!res.ok) throw new Error(`exchangerate ${res.status}`);
  const body = (await res.json()) as { rate?: unknown; time?: unknown } | null;
  const rate = toRate(body?.rate);
  const t = Number(body?.time);
  return { rate, ...(Number.isFinite(t) && t > 0 ? { sourceTime: t * 1000 } : {}) };
}

/**
 * Read WhatsOnChain into the reference. At most one request per WOC_MIN_GAP_MS, backing off 2, 4, 8 … min after
 * failures; a call inside the gap gets the reading from that last attempt (or null if it failed). Never rejects.
 */
function refreshWoc(wocApiKey?: string): Promise<WocRef | null> {
  loadRef();
  if (wocInFlight) return wocInFlight;
  const now = deps.now();
  if (now - wocAttemptAt < WOC_MIN_GAP_MS || now < wocRetryAt)
    return Promise.resolve(wocRef && wocRef.at >= wocAttemptAt ? wocRef : null);
  wocAttemptAt = now;
  wocInFlight = askWoc(wocApiKey)
    .then(
      (r) => {
        const ref: WocRef = { rate: r.rate, at: deps.now(), ...(r.sourceTime ? { sourceTime: r.sourceTime } : {}) };
        wocRef = ref;
        wocFailures = 0;
        wocRetryAt = 0;
        store(WOC_REF_KEY, ref, false);
        return ref;
      },
      () => {
        wocFailures += 1;
        wocRetryAt = deps.now() + backoff(wocFailures);
        return null;
      },
    )
    .finally(() => {
      wocInFlight = null;
    });
  return wocInFlight;
}

/** The reference while young enough to judge a shared price by. */
const youngRef = (now: number): WocRef | null => {
  const r = loadRef();
  return r && now - r.at < WOC_REF_BAND_MAX_AGE_MS ? r : null;
};

// ---- Display rate: the same cent on every device -------------------------------------------------------------------

/** The display rate (shared per-minute price, checked against WhatsOnChain), or 0. Synchronous, for display only. */
export const cachedDisplayRate = (): number => load()?.rate ?? 0;

/** How old the shown (display) price is (ms; WhatsOnChain's own time when known), or null with no price. */
export const exchangeRateAgeMs = (now = deps.now()): number | null => {
  const c = load();
  return c ? Math.max(0, now - (c.sourceTime ?? c.timestamp)) : null;
};

/**
 * The DISPLAY rate, USD per BSV: for the balance headline and the price tile only, never for turning USD into sats
 * (use fetchExchangeRate). Never throws; the last known rate (or 0) when no price can be had.
 */
export function fetchDisplayRate(_chain?: string, wocApiKey?: string): Promise<number> {
  const c = load();
  const now = deps.now();
  if (c && fresh(c, now)) return Promise.resolve(c.rate);
  if (inFlight) return inFlight;
  if (now < retryAt) return Promise.resolve(c?.rate ?? 0);

  const took = (r: Reading, source: 'shared' | 'woc') => {
    save({ rate: r.rate, timestamp: deps.now(), ...(r.sourceTime ? { sourceTime: r.sourceTime } : {}), source });
    failures = 0;
    retryAt = 0;
    return r.rate;
  };
  inFlight = (async () => {
    try {
      const shared = await askShared(now);
      if (shared && !shared.stale) {
        let ref = youngRef(deps.now());
        if (!ref || drift(shared.rate, ref.rate) > SHARED_RECHECK) ref = (await refreshWoc(wocApiKey)) ?? ref;
        // No WhatsOnChain price at all (fresh install, WoC down): shown, but the payment rate stays 0.
        if (!ref || inBand(shared.rate, ref.rate)) return took(shared, 'shared');
        // Out of line with WhatsOnChain: WhatsOnChain decides.
        if (deps.now() - ref.at < RATE_TTL_MS) return took(ref, 'woc');
        throw new Error('shared price out of band');
      }
      const woc = await refreshWoc(wocApiKey);
      if (woc) return took(woc, 'woc');
      // The server's stale value, only when it is newer than what we hold, and kept at its real age (backing off).
      const held = cache ? (cache.sourceTime ?? cache.timestamp) : 0;
      if (shared?.sourceTime && shared.sourceTime > held) {
        const ref = youngRef(deps.now());
        if (!ref || inBand(shared.rate, ref.rate)) {
          save({ rate: shared.rate, timestamp: shared.sourceTime, sourceTime: shared.sourceTime, source: 'shared' });
          fail();
          return shared.rate;
        }
      }
      throw new Error('no price');
    } catch {
      fail();
      return cache?.rate ?? 0;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// ---- Payment rate: what USD amounts are turned into sats with ------------------------------------------------------

/**
 * The PAYMENT rate's entry: the display price while within PAYMENT_TOLERANCE of the WhatsOnChain reference, else the
 * reference itself; null when this device has never had a WhatsOnChain price.
 */
export function paymentRateEntry(): RateEntry | null {
  const ref = loadRef();
  if (!ref) return null;
  const d = cache;
  if (d && d.rate > 0 && drift(d.rate, ref.rate) <= PAYMENT_TOLERANCE) return d;
  return { rate: ref.rate, timestamp: ref.at, ...(ref.sourceTime ? { sourceTime: ref.sourceTime } : {}), source: 'woc' };
}

/** The PAYMENT rate (USD per BSV), or 0. Synchronous; payment-safe. */
export const cachedExchangeRate = (): number => paymentRateEntry()?.rate ?? 0;

/** The PAYMENT rate with its timestamp, or null. */
export const lastKnownExchangeRate = (): RateEntry | null => paymentRateEntry();

/** True when there is no payment rate or it is from an earlier window (show it, but marked stale). */
export const isExchangeRateStale = (): boolean => !fresh(paymentRateEntry(), deps.now());

/**
 * The PAYMENT rate, USD per BSV: use it for every USD → sats conversion. Brings the display price up to date, re-reads
 * WhatsOnChain when the reference is older than WOC_REF_MAX_AGE_MS, then answers paymentRateEntry(). Never throws;
 * 0 when this device has never had a WhatsOnChain price.
 */
export async function fetchExchangeRate(chain?: string, wocApiKey?: string): Promise<number> {
  await fetchDisplayRate(chain, wocApiKey);
  const ref = loadRef();
  if (!ref || deps.now() - ref.at > WOC_REF_MAX_AGE_MS) await refreshWoc(wocApiKey);
  return cachedExchangeRate();
}

/**
 * Keep a screen's DISPLAY price current: ask now, then RATE_FETCH_OFFSET_MS into every minute while the page is
 * visible, so every device reads the price at the same moment. `onRate` gets each price (> 0). Returns the stop function.
 */
export function startAlignedRateRefresh(
  onRate: (rate: number) => void,
  ask: () => Promise<number> = () => fetchDisplayRate('main'),
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
  const readNow = () =>
    void ask()
      .then((r) => !stopped && r > 0 && onRate(r))
      .catch(() => undefined);
  const plan = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      if (visible()) readNow();
      plan();
    }, msToNextRateBucket(deps.now()));
  };
  readNow();
  plan();
  const unsubscribe = subscribeExchangeRate(() => {
    const r = cache?.rate ?? 0;
    if (!stopped && r > 0) onRate(r);
  });
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}

/** Tests only: swap fetch/clock/storage/endpoint/timeouts and clear all state. */
export function __resetExchangeRateForTests(next: Partial<Deps> = {}) {
  deps = { ...deps, ...next };
  cache = null;
  wocRef = null;
  loaded = false;
  inFlight = null;
  failures = 0;
  retryAt = 0;
  wocInFlight = null;
  wocAttemptAt = -Infinity;
  wocFailures = 0;
  wocRetryAt = 0;
}
