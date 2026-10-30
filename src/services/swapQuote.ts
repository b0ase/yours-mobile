/**
 * BSV/USD rate for a bChatX swap (window.CWI.swap). The swap still needs a rate when the terms carry priceSats:
 * swapActions uses it for the USD safety cap and the sheet's USD line. The background worker used to read only the
 * popup's cached rate, so a wallet whose popup had never stored one failed with "No BSV price yet" (30 Oct 2026).
 * Now: a fresh cached rate is used; otherwise the rate is fetched on demand (WhatsOnChain, then CoinGecko, 4 s each)
 * and cached. Only when every source fails does it throw, naming the sources it tried. Pure over deps; tested in
 * swapQuote.test.ts.
 */
import { WOC_MAINNET_URL } from '@1sat/actions';
import type { RateQuote } from '../mobile/p2p/swap/swapActions';

export const SWAP_RATE_TTL_MS = 5 * 60_000;
export const SWAP_RATE_TIMEOUT_MS = 4_000;
export const WOC_RATE_URL = `${WOC_MAINNET_URL}/exchangerate`;
export const COINGECKO_RATE_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash-sv&vs_currencies=usd';

export type CachedRate = { rate: number; timestamp?: number };
export type RateSource = { name: string; url: string; read: (json: unknown) => unknown };

export const RATE_SOURCES: RateSource[] = [
  { name: 'WhatsOnChain', url: WOC_RATE_URL, read: (j) => (j as { rate?: unknown } | null)?.rate },
  {
    name: 'CoinGecko',
    url: COINGECKO_RATE_URL,
    read: (j) => (j as { 'bitcoin-cash-sv'?: { usd?: unknown } } | null)?.['bitcoin-cash-sv']?.usd,
  },
];

export type SwapQuoteDeps = {
  readCache: () => Promise<CachedRate | undefined>;
  writeCache: (r: { rate: number; timestamp: number }) => Promise<void>;
  fetch: typeof fetch;
  now?: () => number;
  sources?: RateSource[];
  timeoutMs?: number;
};

const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

async function fetchRate(f: typeof fetch, s: RateSource, timeoutMs: number): Promise<number> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await f(s.url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`${s.name} ${res.status}`);
    const v = Number(s.read(await res.json()));
    if (!valid(v)) throw new Error(`${s.name} bad rate`);
    return v;
  } finally {
    clearTimeout(timer);
  }
}

/** Returns a RateQuote or throws a clear error naming every source tried. Never returns undefined. */
export function makeSwapQuote(d: SwapQuoteDeps): () => Promise<RateQuote> {
  const now = d.now ?? (() => Date.now());
  const sources = d.sources ?? RATE_SOURCES;
  const timeoutMs = d.timeoutMs ?? SWAP_RATE_TIMEOUT_MS;
  return async () => {
    const c = await d.readCache().catch(() => undefined);
    // A cached rate without a timestamp (the popup's legacy cache) is treated as stale: try fresh first.
    if (c && valid(c.rate) && typeof c.timestamp === 'number' && now() - c.timestamp < SWAP_RATE_TTL_MS)
      return { rate: c.rate, source: 'bWalletX price feed (cached BSV/USD rate)' };
    for (const s of sources) {
      try {
        const rate = await fetchRate(d.fetch, s, timeoutMs);
        await d.writeCache({ rate, timestamp: now() }).catch(() => undefined);
        return { rate, source: `${s.name} BSV/USD rate` };
      } catch {
        /* next source */
      }
    }
    throw new Error(
      `Couldn't get the BSV price (tried ${sources.map((s) => s.name).join(', ')}). Check your connection and try again`,
    );
  };
}
