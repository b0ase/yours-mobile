/**
 * Display currency (Settings › Currency): USD (default) or GBP. Display only — every amount stays
 * defined and computed in US dollars internally (payment maths, protocol prices like the 1¢ Penny post);
 * this layer converts at format time. GBP uses the Bank of England USD/GBP rate already used by
 * History › Gains (wallet/fiatRates.ts, cached in localStorage by day). No rate yet → shows USD.
 * Persisted per device in localStorage.
 */
export type DisplayCurrency = 'USD' | 'GBP';
export const DISPLAY_CURRENCIES: DisplayCurrency[] = ['USD', 'GBP'];

const KEY = 'bwx.displayCurrency';
/** Same cache key as wallet/fiatRates.ts (USD_PER_GBP_KEY): day → US$ per £. */
const GBP_CACHE_KEY = 'bwx.fx.usdpergbp';
const EVENT = 'bwx:display-currency';

export const getDisplayCurrency = (): DisplayCurrency => {
  try {
    return localStorage.getItem(KEY) === 'GBP' ? 'GBP' : 'USD';
  } catch {
    return 'USD';
  }
};

export const setDisplayCurrency = (c: DisplayCurrency) => {
  try {
    localStorage.setItem(KEY, c);
  } catch {
    /* private mode: setting lasts this session only via the event */
  }
  if (c === 'GBP') void refreshFxRate();
  try {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: c }));
  } catch {
    /* no window (tests) */
  }
};

export const onDisplayCurrencyChange = (cb: () => void) => {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
};

/** Latest cached US$ per £ and its day (YYYY-MM-DD), or null. */
export const latestUsdPerGbp = (): { rate: number; day: string } | null => {
  try {
    const m = JSON.parse(localStorage.getItem(GBP_CACHE_KEY) ?? '{}') as Record<string, number>;
    const days = Object.keys(m)
      .filter((d) => m[d] > 0)
      .sort();
    const day = days[days.length - 1];
    return day ? { rate: m[day], day } : null;
  } catch {
    return null;
  }
};

let refreshing: Promise<void> | null = null;
/** Fetch recent USD/GBP rates into the cache (Bank of England, via fiatRates). Never throws. */
export const refreshFxRate = (): Promise<void> => {
  const latest = latestUsdPerGbp();
  // Fresh enough: the Bank publishes once per business day.
  if (latest && Date.now() - Date.parse(`${latest.day}T00:00:00Z`) < 4 * 86_400_000) return Promise.resolve();
  if (!refreshing) {
    refreshing = import('../mobile/wallet/fiatRates')
      .then((f) => f.usdPerGbp(Date.now() - 14 * 86_400_000))
      .then(() => {
        try {
          window.dispatchEvent(new CustomEvent(EVENT));
        } catch {
          /* no window */
        }
      })
      .catch(() => undefined)
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
};

/** The currency actually shown: GBP only when chosen AND a rate is known. */
export type Fx = { currency: DisplayCurrency; usdPerUnit: number };
export const currentFx = (): Fx => {
  if (getDisplayCurrency() === 'GBP') {
    const r = latestUsdPerGbp();
    if (r) return { currency: 'GBP', usdPerUnit: r.rate };
  }
  return { currency: 'USD', usdPerUnit: 1 };
};

const SYMBOL: Record<DisplayCurrency, string> = { USD: '$', GBP: '£' };
const LOCALE: Record<DisplayCurrency, string> = { USD: 'en-US', GBP: 'en-GB' };

export const fiatSymbol = (fx: Fx = currentFx()) => SYMBOL[fx.currency];
export const fiatCode = (fx: Fx = currentFx()) => fx.currency;

/** US dollars → display units. */
export const usdToFiat = (usd: number, fx: Fx = currentFx()) => usd / fx.usdPerUnit;
/** Display units → US dollars (e.g. a £5 quick chip). */
export const fiatToUsd = (amount: number, fx: Fx = currentFx()) => amount * fx.usdPerUnit;

export type FormatOpts = {
  /** Sub-cent amounts keep one significant digit ("$0.0006") instead of rounding to 0.00. */
  small?: boolean;
  /** Prefix "≈ " when the amount was converted (protocol prices defined in USD). */
  approx?: boolean;
  /** Whole units for large amounts (≥ 100): "$1,234". */
  wholeAbove100?: boolean;
};

/** Format a US-dollar amount in the display currency: "$12.34" or "£9.12". Pure given `fx`. */
export const formatFiat = (usd: number, fx: Fx = currentFx(), opts: FormatOpts = {}): string => {
  if (!Number.isFinite(usd)) return '';
  const v = usdToFiat(usd, fx);
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  const sym = SYMBOL[fx.currency];
  const pre = opts.approx && fx.currency !== 'USD' ? '≈ ' : '';
  let body: string;
  if (opts.small && a > 0 && a < 0.01) {
    body = Number(a.toPrecision(1)).toFixed(Math.max(2, -Math.floor(Math.log10(a))));
  } else if (opts.wholeAbove100 && a >= 100) {
    body = Math.round(a).toLocaleString(LOCALE[fx.currency]);
  } else {
    body = a.toLocaleString(LOCALE[fx.currency], { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return `${pre}${sign}${sym}${body}`;
};
