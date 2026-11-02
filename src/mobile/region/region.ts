import { BUY_CRYPTO_ENABLED, MARKET_ENABLED, SWAP_ENABLED } from '../storeBuild';

/**
 * UK financial-promotion gate (CEO ruling, bitcoin-corp/legal/ROOM-TOKENS-UK-FINPROM-2026-11-02.md). The Exchange /
 * Market, Swap into BSV and Buy BSV invite people to buy cryptoassets, so UK visitors do not see them. Holding,
 * sending, receiving, balances, signing, private mint and rooms stay on for everyone.
 *
 * Effective gate = the compile-time flag (storeBuild.ts, false in every store build, unchanged) AND not restricted
 * here. The country comes from our own endpoint (api/geo.mjs on web.bwalletx.com, Vercel's x-vercel-ip-country
 * header); there is no third-party IP lookup. The web wallet, the Chrome extension and Desktop all ask the same URL.
 *
 * Fail closed: until a lookup succeeds, and whenever it fails or times out (3 s), the user is treated as restricted.
 * A successful answer (UK or not) is cached for 24 hours in localStorage; storage errors are ignored.
 */

/** United Kingdom plus the Crown dependencies (Guernsey, Jersey, Isle of Man). */
export const UK_COUNTRIES: readonly string[] = ['GB', 'GG', 'JE', 'IM'];

/** checking: no answer yet. allowed: lookup said not UK. uk: lookup said UK. unknown: lookup failed (fail closed). */
export type RegionStatus = 'checking' | 'allowed' | 'uk' | 'unknown';

/** Store builds have none of the gated features, so they never ask (literal flags, folded at build time). */
export const REGION_GATE_ON: boolean = MARKET_ENABLED || SWAP_ENABLED || BUY_CRYPTO_ENABLED;

export const GEO_URL: string = REGION_GATE_ON ? 'https://web.bwalletx.com/api/geo' : '';
export const REGION_CACHE_KEY = 'bwx.region.v1';
export const REGION_CACHE_MS = 24 * 60 * 60 * 1000;
export const REGION_TIMEOUT_MS = 3000;

/** A two-letter country code, upper-cased, or null. */
export const normaliseCountry = (c: unknown): string | null =>
  typeof c === 'string' && /^[A-Za-z]{2}$/.test(c.trim()) ? c.trim().toUpperCase() : null;

export const isUkCountry = (c: string | null | undefined): boolean => {
  const n = normaliseCountry(c);
  return !!n && UK_COUNTRIES.includes(n);
};

/** No country (lookup failed or the header was missing) is unknown, which is restricted. */
export const statusForCountry = (c: string | null | undefined): RegionStatus => {
  const n = normaliseCountry(c);
  if (!n) return 'unknown';
  return UK_COUNTRIES.includes(n) ? 'uk' : 'allowed';
};

/** Only a positive "not UK" answer unlocks anything. */
export const isRestrictedStatus = (s: RegionStatus): boolean => s !== 'allowed';

type KV = Pick<Storage, 'getItem' | 'setItem'>;
type CachedRegion = { country: string; at: number };

const defaultStorage = (): KV | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

/** The cached country if it is younger than 24 hours. */
export const readRegionCache = (storage: KV | null = defaultStorage(), now = Date.now()): string | null => {
  try {
    const raw = storage?.getItem(REGION_CACHE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<CachedRegion>;
    const country = normaliseCountry(v?.country);
    if (!country || typeof v.at !== 'number') return null;
    if (v.at > now || now - v.at >= REGION_CACHE_MS) return null;
    return country;
  } catch {
    return null;
  }
};

export const writeRegionCache = (country: string, storage: KV | null = defaultStorage(), now = Date.now()) => {
  try {
    storage?.setItem(REGION_CACHE_KEY, JSON.stringify({ country, at: now } satisfies CachedRegion));
  } catch {
    /* private mode / quota: just ask again next time */
  }
};

/** Asks our endpoint for the visitor's country. Null on any failure, a bad answer or after the timeout. */
export const lookupCountry = async (
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = REGION_TIMEOUT_MS,
  url = GEO_URL,
): Promise<string | null> => {
  if (!url || typeof fetchImpl !== 'function') return null;
  const ctl = typeof AbortController === 'undefined' ? null : new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((done) => {
    timer = setTimeout(() => {
      ctl?.abort();
      done(null);
    }, timeoutMs);
  });
  const ask = (async () => {
    try {
      const res = await fetchImpl(url, { cache: 'no-store', credentials: 'omit', signal: ctl?.signal });
      if (!res.ok) return null;
      const body = (await res.json()) as { country?: unknown } | null;
      return normaliseCountry(body?.country);
    } catch {
      return null;
    }
  })();
  try {
    return await Promise.race([ask, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

export type ResolveDeps = {
  fetchImpl?: typeof fetch;
  storage?: KV | null;
  now?: number;
  timeoutMs?: number;
  /** Skip the cache (Retry). */
  force?: boolean;
};

/** Cache first, then the endpoint. Only successful answers are cached; a failure is 'unknown' (restricted). */
export const resolveRegion = async ({
  fetchImpl = globalThis.fetch,
  storage = defaultStorage(),
  now = Date.now(),
  timeoutMs = REGION_TIMEOUT_MS,
  force = false,
}: ResolveDeps = {}): Promise<{ status: RegionStatus; country: string | null }> => {
  if (!force) {
    const cached = readRegionCache(storage, now);
    if (cached) return { status: statusForCountry(cached), country: cached };
  }
  const country = await lookupCountry(fetchImpl, timeoutMs);
  if (!country) return { status: 'unknown', country: null };
  writeRegionCache(country, storage, now);
  return { status: statusForCountry(country), country };
};

export type RegionGateKind = 'market' | 'swap' | 'buy';

const GATE_FLAG: Record<RegionGateKind, boolean> = {
  market: MARKET_ENABLED,
  swap: SWAP_ENABLED,
  buy: BUY_CRYPTO_ENABLED,
};

/** What a guarded route shows: the page only after a positive "not UK" answer; 'off' when the build has no such page. */
export const gateView = (kind: RegionGateKind, s: RegionStatus): 'page' | 'checking' | 'uk' | 'unknown' | 'off' => {
  if (!GATE_FLAG[kind]) return 'off';
  return s === 'allowed' ? 'page' : s;
};

/* ---------- App-wide state (one lookup per run, shared by every gate) ---------- */

const initialStatus = (): RegionStatus => {
  if (!REGION_GATE_ON) return 'unknown';
  const cached = readRegionCache();
  return cached ? statusForCountry(cached) : 'checking';
};

let status: RegionStatus = initialStatus();
let inflight: Promise<RegionStatus> | null = null;
/** The automatic lookup runs once per app run; after a failure only Retry asks again (no request per mount). */
let autoStarted = false;
const listeners = new Set<() => void>();

const setStatus = (s: RegionStatus) => {
  if (s === status) return;
  status = s;
  for (const l of listeners) l();
};

export const getRegionStatus = (): RegionStatus => status;

export const subscribeRegion = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** Starts the lookup once per run (no-op in store builds or when a cached answer is already in). */
export const startRegionCheck = (force = false): Promise<RegionStatus> => {
  if (!REGION_GATE_ON) return Promise.resolve(status);
  if (inflight) return inflight;
  if (!force && (autoStarted || status === 'allowed' || status === 'uk')) return Promise.resolve(status);
  autoStarted = true;
  if (force) setStatus('checking');
  inflight = resolveRegion({ force })
    .then((r) => r.status)
    .catch((): RegionStatus => 'unknown')
    .then((s) => {
      setStatus(s);
      inflight = null;
      return s;
    });
  return inflight;
};

/** "Retry" on the region note: ask the endpoint again, ignoring the cache. */
export const retryRegionCheck = () => startRegionCheck(true);

/** True unless a lookup has said "not UK" (fail closed). */
export const isUkRestricted = (): boolean => isRestrictedStatus(status);

/** Effective gates for code outside React (the hooks in useRegion.ts re-render on change). */
export const marketAllowed = (): boolean => MARKET_ENABLED && !isUkRestricted();
export const swapAllowed = (): boolean => SWAP_ENABLED && !isUkRestricted();
export const buyCryptoAllowed = (): boolean => BUY_CRYPTO_ENABLED && !isUkRestricted();

/** Tests only: set the state directly. */
export const __setRegionStatusForTests = (s: RegionStatus) => {
  inflight = null;
  autoStarted = false;
  setStatus(s);
};
