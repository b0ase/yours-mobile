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
 * RATE_FETCH_OFFSET_MS into each minute (startAlignedRateRefresh), so they read the same WhatsOnChain tick (it moves every
 * ~20 s). The balance is turned into cents by one function on every build (utils/balanceUsd.ts).
 *
 * One shared price per minute (owner, 13 Nov 2026): reading WhatsOnChain at the same moment still let two devices land
 * on either side of a WoC tick. So the wallet first asks our own server (pay.bwallet.space GET /api/price?m=<minute>,
 * site/lib/sharedPrice.js), keyed by this window's wall-clock minute: the first request for a minute fixes its value
 * and every device asking for that minute gets the identical number. If the server fails, answers out of line with the
 * last known price, or says its own value is stale, the wallet asks WhatsOnChain directly as before. The source used
 * is kept with the price (`source: 'shared' | 'woc'`).
 */
import { WOC_MAINNET_URL } from '@1sat/actions';
import { BWALLET_PAYMAIL_API } from '../mobile/names/config';

export const RATE_TTL_MS = 60_000;
export const BACKOFF_START_MS = 2 * 60_000;
export const BACKOFF_MAX_MS = 15 * 60_000;
export const STORAGE_KEY = 'bwx.exchangeRate.v1';
/** Into each minute, the moment the wallet screens ask for the price (every device the same moment). */
export const RATE_FETCH_OFFSET_MS = 2_000;

/**
 * `timestamp`: when this device fetched it. `sourceTime`: WhatsOnChain's own time for the price (ms), when it said.
 * `source`: 'shared' = our per-minute endpoint, 'woc' = WhatsOnChain asked directly (absent on prices stored before).
 */
export type RateEntry = { rate: number; timestamp: number; sourceTime?: number; source?: 'shared' | 'woc' };
/** How long the shared endpoint gets before the wallet asks WhatsOnChain itself. */
export const SHARED_TIMEOUT_MS = 4_000;
/**
 * A shared price is only taken while it is within this band of a last known price younger than SHARED_BAND_MAX_AGE_MS;
 * outside it the wallet asks WhatsOnChain directly. The price turns USD amounts into sats for some payments, so one
 * wrong number from our server (a bug, a bad deploy) must not become what the wallet pays with.
 */
export const SHARED_BAND = { low: 0.8, high: 1.25 };
export const SHARED_BAND_MAX_AGE_MS = 24 * 60 * 60_000;

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
};

let cache: RateEntry | null = null;
let loaded = false;
let inFlight: Promise<number> | null = null;
let failures = 0;
let retryAt = 0;

function load(): RateEntry | null {
  if (loaded) return cache;
  loaded = true;
  try {
    const raw = deps.storage?.getItem(STORAGE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as RateEntry;
      if (Number.isFinite(v?.rate) && v.rate > 0 && Number.isFinite(v.timestamp)) cache = v;
    }
  } catch {
    /* no storage: start empty */
  }
  return cache;
}

const listeners = new Set<() => void>();
/** Called whenever a new price is stored (any screen's fetch); returns the unsubscribe. */
export const subscribeExchangeRate = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => void listeners.delete(cb);
};

function save(entry: RateEntry) {
  cache = entry;
  try {
    deps.storage?.setItem(STORAGE_KEY, JSON.stringify(entry));
  } catch {
    /* ignore */
  }
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch {
      /* a listener's failure is its own */
    }
  }
}

function fail() {
  failures += 1;
  retryAt = deps.now() + Math.min(BACKOFF_START_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
}

/** Last known rate (even if old), or 0. Synchronous, for display. */
export const cachedExchangeRate = (): number => load()?.rate ?? 0;

/** The last known rate with its timestamp, or null. */
export const lastKnownExchangeRate = (): RateEntry | null => load();

/** True when there is no price or it is from an earlier window (show it, but marked stale). */
export const isExchangeRateStale = (): boolean => !fresh(load(), deps.now());

/** How old the shown price is (ms; WhatsOnChain's own time when known), or null with no price. */
export const exchangeRateAgeMs = (now = deps.now()): number | null => {
  const c = load();
  return c ? Math.max(0, now - (c.sourceTime ?? c.timestamp)) : null;
};

type Reading = { rate: number; sourceTime?: number };

const toRate = (v: unknown): number => {
  const rate = Number(Number(v).toFixed(2));
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('bad rate');
  return rate;
};

/** The shared per-minute price, or null (no endpoint, failure, timeout, out of band). `stale`: the server said so. */
async function askShared(now: number): Promise<(Reading & { stale: boolean }) | null> {
  if (!deps.sharedBase) return null;
  const ctl = typeof AbortController === 'undefined' ? null : new AbortController();
  const timer = ctl ? setTimeout(() => ctl.abort(), SHARED_TIMEOUT_MS) : undefined;
  try {
    const res = await deps.fetch(sharedPriceUrl(deps.sharedBase, now), ctl ? { signal: ctl.signal } : undefined);
    if (!res.ok) return null;
    const body = (await res.json()) as { bsvUsd?: unknown; sourceTime?: unknown; stale?: unknown } | null;
    const rate = toRate(body?.bsvUsd);
    const ref = cache;
    if (ref && now - ref.timestamp < SHARED_BAND_MAX_AGE_MS) {
      const ratio = rate / ref.rate;
      if (!(ratio >= SHARED_BAND.low && ratio <= SHARED_BAND.high)) return null;
    }
    const t = Number(body?.sourceTime);
    return { rate, ...(Number.isFinite(t) && t > 0 ? { sourceTime: t } : {}), stale: body?.stale === true };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function askWoc(wocApiKey?: string): Promise<Reading> {
  const headers: Record<string, string> = {};
  if (wocApiKey) headers['woc-api-key'] = wocApiKey;
  const res = await deps.fetch(`${WOC_MAINNET_URL}/exchangerate`, { headers });
  if (!res.ok) throw new Error(`exchangerate ${res.status}`);
  const body = (await res.json()) as { rate?: unknown; time?: unknown } | null;
  const rate = toRate(body?.rate);
  const t = Number(body?.time);
  return { rate, ...(Number.isFinite(t) && t > 0 ? { sourceTime: t * 1000 } : {}) };
}

/**
 * USD per BSV. Never throws; returns the last known rate (or 0) when no price can be had. Asks the shared per-minute
 * endpoint first, WhatsOnChain directly when that fails (or only has a stale value, which is used if WoC fails too).
 */
export function fetchExchangeRate(_chain?: string, wocApiKey?: string): Promise<number> {
  const c = load();
  const now = deps.now();
  if (c && fresh(c, now)) return Promise.resolve(c.rate);
  if (inFlight) return inFlight;
  if (now < retryAt) return Promise.resolve(c?.rate ?? 0);

  inFlight = (async () => {
    try {
      const shared = await askShared(now);
      let got: Reading & { source: 'shared' | 'woc' };
      if (shared && !shared.stale) got = { ...shared, source: 'shared' };
      else {
        try {
          got = { ...(await askWoc(wocApiKey)), source: 'woc' };
        } catch (e) {
          if (!shared) throw e;
          got = { ...shared, source: 'shared' };
        }
      }
      const { rate, sourceTime, source } = got;
      save({ rate, timestamp: deps.now(), ...(sourceTime ? { sourceTime } : {}), source });
      failures = 0;
      retryAt = 0;
      return rate;
    } catch {
      fail();
      return cache?.rate ?? 0;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Keep a screen's price current: ask now, then RATE_FETCH_OFFSET_MS into every minute while the page is visible, so
 * every device reads the price at the same moment. `onRate` gets each price (> 0). Returns the stop function.
 */
export function startAlignedRateRefresh(
  onRate: (rate: number) => void,
  ask: () => Promise<number> = () => fetchExchangeRate('main'),
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
  const read = () =>
    void ask()
      .then((r) => !stopped && r > 0 && onRate(r))
      .catch(() => undefined);
  const plan = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      if (visible()) read();
      plan();
    }, msToNextRateBucket(deps.now()));
  };
  read();
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

/** Tests only: swap fetch/clock/storage and clear all state. */
export function __resetExchangeRateForTests(next: Partial<Deps> = {}) {
  deps = { ...deps, ...next };
  cache = null;
  loaded = false;
  inFlight = null;
  failures = 0;
  retryAt = 0;
}
