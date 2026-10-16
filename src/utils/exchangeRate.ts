/**
 * One shared BSV/USD price for the whole app (owner, 16 Oct 2026: WhatsOnChain answered 429 on the iPhone because
 * every screen fetched the price on its own; a 429 carries no CORS header, so it showed as a CORS error).
 *
 * - one in-flight request at a time: callers that ask together share it;
 * - a fresh price is reused for at least 60 s;
 * - the last known price is kept in localStorage with its timestamp, so a restart starts with a price;
 * - on a 429 or a network failure we wait 2, 4, 8 … minutes (capped at 15) before asking again;
 * - callers always get the last known price (marked stale) instead of nothing.
 */
import { WOC_MAINNET_URL } from '@1sat/actions';

export const RATE_TTL_MS = 60_000;
export const BACKOFF_START_MS = 2 * 60_000;
export const BACKOFF_MAX_MS = 15 * 60_000;
export const STORAGE_KEY = 'bwx.exchangeRate.v1';

export type RateEntry = { rate: number; timestamp: number };

type Deps = {
  fetch: typeof fetch;
  now: () => number;
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
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

function save(entry: RateEntry) {
  cache = entry;
  try {
    deps.storage?.setItem(STORAGE_KEY, JSON.stringify(entry));
  } catch {
    /* ignore */
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

/** True when there is no price or it is older than the TTL (show it, but marked stale). */
export const isExchangeRateStale = (): boolean => {
  const c = load();
  return !c || deps.now() - c.timestamp >= RATE_TTL_MS;
};

/** USD per BSV. Never throws; returns the last known rate (or 0) when WhatsOnChain cannot be asked or fails. */
export function fetchExchangeRate(_chain?: string, wocApiKey?: string): Promise<number> {
  const c = load();
  const now = deps.now();
  if (c && now - c.timestamp < RATE_TTL_MS) return Promise.resolve(c.rate);
  if (inFlight) return inFlight;
  if (now < retryAt) return Promise.resolve(c?.rate ?? 0);

  const headers: Record<string, string> = {};
  if (wocApiKey) headers['woc-api-key'] = wocApiKey;
  inFlight = (async () => {
    try {
      const res = await deps.fetch(`${WOC_MAINNET_URL}/exchangerate`, { headers });
      if (!res.ok) throw new Error(`exchangerate ${res.status}`);
      const rate = Number(Number((await res.json())?.rate).toFixed(2));
      if (!Number.isFinite(rate) || rate <= 0) throw new Error('bad rate');
      save({ rate, timestamp: deps.now() });
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

/** Tests only: swap fetch/clock/storage and clear all state. */
export function __resetExchangeRateForTests(next: Partial<Deps> = {}) {
  deps = { ...deps, ...next };
  cache = null;
  loaded = false;
  inFlight = null;
  failures = 0;
  retryAt = 0;
}
