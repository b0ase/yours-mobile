/**
 * USD-first money display. Owner rule: everything is priced in US dollars and cents; sats only at
 * payment time, and the UI shows USD first (sats at most as small secondary text). Internal math
 * stays in whole sats — these helpers only convert for display and for USD-entered prices.
 * `rate` is USD per BSV (fetchExchangeRate); 0 / non-finite = unknown, and callers fall back to sats.
 */
import { useEffect, useState } from 'react';
import { cachedExchangeRate, fetchExchangeRate } from '../../utils/wallet';

const SATS_PER_BSV = 100_000_000;
export const hasRate = (rate: number) => Number.isFinite(rate) && rate > 0;

export const satsToUsd = (sats: number, rate: number): number | null =>
  hasRate(rate) && Number.isFinite(sats) ? (sats / SATS_PER_BSV) * rate : null;

/** Whole sats for a USD amount at `rate`, rounded up (never under-pay a USD price). null when unknown. */
export const usdToSats = (usd: number, rate: number): number | null => {
  if (!hasRate(rate) || !Number.isFinite(usd) || usd <= 0) return null;
  // Round to micro-sats first so float noise (0.01/50*1e8 = 20000.000000004) does not add a sat.
  const sats = Math.ceil(Math.round((usd / rate) * SATS_PER_BSV * 1e6) / 1e6);
  return Number.isSafeInteger(sats) ? sats : null;
};

/** "$12.34", "$1,234.50", "$0.05"; sub-cent amounts keep one significant digit: "$0.0006". */
export const fmtUsd = (usd: number): string => {
  if (!Number.isFinite(usd)) return '';
  const sign = usd < 0 ? '-' : '';
  const a = Math.abs(usd);
  if (a > 0 && a < 0.01) return `${sign}$${Number(a.toPrecision(1)).toFixed(Math.max(2, -Math.floor(Math.log10(a))))}`;
  return `${sign}$${a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export const fmtSats = (sats: number) => `${Math.round(sats).toLocaleString('en-US')} sats`;

/** USD when the rate is known, else "N sats" (the fallback). */
export const money = (sats: number, rate: number): string => {
  const usd = satsToUsd(sats, rate);
  return usd === null ? fmtSats(sats) : fmtUsd(usd);
};

/** Secondary sats text to show small next to a USD price: "≈ 1,234 sats" ('' when the rate is unknown, since money() already shows sats). */
export const satsNote = (sats: number, rate: number): string => (hasRate(rate) ? `≈ ${fmtSats(sats)}` : '');

/** "$0.01 (≈ 20,000 sats)" for single-string slots (confirm-sheet lines, toasts); "N sats" without a rate. */
export const moneyWithSats = (sats: number, rate: number): string =>
  hasRate(rate) ? `${money(sats, rate)} (${fmtSats(sats)})` : fmtSats(sats);

/** Parse a "$1.25" / "1.25" price field: dollars with at most 2 decimals, > 0. null if invalid. */
export const parseUsdInput = (s: string): number | null => {
  const t = s.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d*(\.\d{0,2})?$/.test(t) || !/\d/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};

/** The USD-per-BSV rate (cached by fetchExchangeRate). 0 until known or when unavailable. */
export const useBsvUsd = (): number => {
  const [rate, setRate] = useState(0);
  useEffect(() => {
    let live = true;
    fetchExchangeRate('main')
      .then((r) => live && setRate(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return rate;
};

/**
 * money() at the app's last known rate (prefetched at startup), for labels built outside React
 * (market floors, notifications, lock amounts). "N sats" until a rate has been fetched.
 */
export const moneyNow = (sats: number): string => money(sats, cachedExchangeRate());
