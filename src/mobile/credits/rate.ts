/**
 * Live BSV/GBP for a bCredits top-up. The server values a deposit at CoinGecko's BSV/GBP when it confirms
 * (bit-sign liveGbpRate), so the wallet quotes from the same source. Fallback: the wallet's BSV/USD ÷ the cached
 * Bank of England US$ per £. Null when neither is known: the sheet then refuses to send (never a made-up rate).
 */
import { fetchExchangeRate } from '../../utils/wallet';
import { latestUsdPerGbp, refreshFxRate } from '../../utils/displayCurrency';

export const parseGeckoGbp = (data: unknown): number | null => {
  const g = Number((data as { 'bitcoin-cash-sv'?: { gbp?: unknown } } | null)?.['bitcoin-cash-sv']?.gbp);
  return Number.isFinite(g) && g > 0 ? g : null;
};

export const parseGeckoUsd = (data: unknown): number | null => {
  const u = Number((data as { 'bitcoin-cash-sv'?: { usd?: unknown } } | null)?.['bitcoin-cash-sv']?.usd);
  return Number.isFinite(u) && u > 0 ? u : null;
};

/** BSV in the server's credits currency: USD (the server values USD deposits at the live BSV/USD rate) or GBP. */
export async function liveRatePerBsv(currency: 'USD' | 'GBP'): Promise<number | null> {
  if (currency === 'GBP') return liveGbpPerBsv();
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash-sv&vs_currencies=usd', {
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const u = parseGeckoUsd(await res.json());
      if (u) return u;
    }
  } catch {
    /* fall back */
  }
  try {
    const usd = await fetchExchangeRate('main');
    if (usd > 0) return usd;
  } catch {
    /* no rate */
  }
  return null;
}

export async function liveGbpPerBsv(): Promise<number | null> {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash-sv&vs_currencies=gbp', {
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const g = parseGeckoGbp(await res.json());
      if (g) return g;
    }
  } catch {
    /* fall back */
  }
  try {
    await refreshFxRate();
    const usd = await fetchExchangeRate('main');
    const fx = latestUsdPerGbp();
    if (usd > 0 && fx && fx.rate > 0) return usd / fx.rate;
  } catch {
    /* no rate */
  }
  return null;
}
