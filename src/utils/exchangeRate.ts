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
 */
import { WOC_MAINNET_URL } from '@1sat/actions';

export const RATE_TTL_MS = 60_000;
export const BACKOFF_START_MS = 2 * 60_000;
export const BACKOFF_MAX_MS = 15 * 60_000;
export const STORAGE_KEY = 'bwx.exchangeRate.v1';
/** Into each minute, the moment the wallet screens ask for the price (every device the same moment). */
export const RATE_FETCH_OFFSET_MS = 2_000;

/** `timestamp`: when this device fetched it. `sourceTime`: WhatsOnChain's own time for the price (ms), when it said. */
export type RateEntry = { rate: number; timestamp: number; sourceTime?: number };

/** The wall-clock window a price belongs to: RATE_TTL_MS long, starting RATE_FETCH_OFFSET_MS into each minute. */
export const rateBucket = (ms: number): number => Math.floor((ms - RATE_FETCH_OFFSET_MS) / RATE_TTL_MS);
/** Milliseconds from `now` until the next window starts (always > 0). */
export const msToNextRateBucket = (now: number): number =>
  (rateBucket(now) + 1) * RATE_TTL_MS + RATE_FETCH_OFFSET_MS - now;
const fresh = (c: RateEntry | null, now: number): boolean => !!c && rateBucket(c.timestamp) === rateBucket(now);

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

/** USD per BSV. Never throws; returns the last known rate (or 0) when WhatsOnChain cannot be asked or fails. */
export function fetchExchangeRate(_chain?: string, wocApiKey?: string): Promise<number> {
  const c = load();
  const now = deps.now();
  if (c && fresh(c, now)) return Promise.resolve(c.rate);
  if (inFlight) return inFlight;
  if (now < retryAt) return Promise.resolve(c?.rate ?? 0);

  const headers: Record<string, string> = {};
  if (wocApiKey) headers['woc-api-key'] = wocApiKey;
  inFlight = (async () => {
    try {
      const res = await deps.fetch(`${WOC_MAINNET_URL}/exchangerate`, { headers });
      if (!res.ok) throw new Error(`exchangerate ${res.status}`);
      const body = (await res.json()) as { rate?: unknown; time?: unknown } | null;
      const rate = Number(Number(body?.rate).toFixed(2));
      if (!Number.isFinite(rate) || rate <= 0) throw new Error('bad rate');
      const t = Number(body?.time);
      save({ rate, timestamp: deps.now(), ...(Number.isFinite(t) && t > 0 ? { sourceTime: t * 1000 } : {}) });
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
