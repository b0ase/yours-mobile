import type { PricePoint, RangeId } from './portfolioMath';

/**
 * Market prices for Portfolio vs market. CoinGecko's public chart API for BSV and BTC (no key, CORS open); BSV
 * falls back to WhatsOnChain's daily rate (the source the BSV chart and History already use). Each series is
 * cached for 5 minutes per range. A failed fetch gives [] and the screen says that comparison is unavailable.
 */
const CG = 'https://api.coingecko.com/api/v3/coins';
const WOC = 'https://api.whatsonchain.com/v1/bsv/main/exchangerate/historical';
export const COIN_IDS = { bsv: 'bitcoin-cash-sv', btc: 'bitcoin' } as const;
export type Coin = keyof typeof COIN_IDS;

const DAYS: Record<RangeId, string> = { '1D': '1', '1W': '7', '1M': '30', '1Y': '365', ALL: 'max' };
const TTL = 5 * 60_000;
const cache = new Map<string, { at: number; data: PricePoint[] }>();

/** CoinGecko market_chart → sorted points; anything malformed is dropped. */
export const parseCoinGecko = (j: unknown): PricePoint[] => {
  const prices = (j as { prices?: unknown })?.prices;
  if (!Array.isArray(prices)) return [];
  return prices
    .filter(
      (x): x is [number, number] =>
        Array.isArray(x) && typeof x[0] === 'number' && typeof x[1] === 'number' && x[1] > 0,
    )
    .map(([t, p]) => ({ t, p }))
    .sort((a, b) => a.t - b.t);
};

/** WhatsOnChain daily rates ({time (s), rate}) → sorted points. */
export const parseWoc = (j: unknown): PricePoint[] =>
  Array.isArray(j)
    ? (j as { time?: number; rate?: number }[])
        .filter((x) => typeof x.time === 'number' && typeof x.rate === 'number' && x.rate > 0)
        .map((x) => ({ t: (x.time as number) * 1000, p: x.rate as number }))
        .sort((a, b) => a.t - b.t)
    : [];

const getJson = async (url: string, f: typeof fetch) => {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const timer = ctl ? setTimeout(() => ctl.abort(), 12_000) : undefined;
  try {
    const r = await f(url, ctl ? { signal: ctl.signal } : undefined);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** WhatsOnChain BSV daily rates from `fromMs`, in yearly windows. */
const wocBsv = async (fromMs: number, f: typeof fetch) => {
  const now = Math.floor(Date.now() / 1000);
  const out: PricePoint[] = [];
  for (let from = Math.floor(fromMs / 1000); from < now; from += 365 * 86400)
    out.push(...parseWoc(await getJson(`${WOC}?from=${from}&to=${Math.min(now, from + 365 * 86400)}`, f)));
  return out.sort((a, b) => a.t - b.t);
};

/** Price history for a coin over a range; [] when unavailable. `fromMs` is used by the BSV fallback. */
export const fetchSeries = async (coin: Coin, range: RangeId, fromMs: number, f: typeof fetch = fetch) => {
  const key = `${coin}:${range}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  let data = parseCoinGecko(
    await getJson(`${CG}/${COIN_IDS[coin]}/market_chart?vs_currency=usd&days=${DAYS[range]}`, f),
  );
  if (!data.length && coin === 'bsv' && range !== '1D') data = await wocBsv(fromMs, f);
  if (data.length) cache.set(key, { at: Date.now(), data });
  return data;
};
