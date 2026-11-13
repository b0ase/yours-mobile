/**
 * The wallet balance in dollars: one function for every build, so the extension and the iPhone show the same cent for
 * the same sats and price (owner, 13 Nov 2026: "one penny different… not acceptable").
 *
 * The old figure was `sats / 1e8 * rate` in floating point, rounded by toLocaleString at display, with MNEE added as a
 * float on top. Here the BSV part is turned into whole cents once, in integer maths (BigInt, so no balance is too big),
 * rounding half up, and MNEE is added as whole cents too. Display only: what gets sent or signed never uses this.
 */
import { formatFiat, type Fx } from './displayCurrency';

const SATS_PER_BSV = 100_000_000n;

/** The price in millionths of a dollar per BSV (prices are quoted to the cent; this keeps any finer quote exact). */
const microUsd = (usdPerBsv: number): bigint =>
  Number.isFinite(usdPerBsv) && usdPerBsv > 0 ? BigInt(Math.round(usdPerBsv * 1_000_000)) : 0n;

/** US cents for `sats` at `usdPerBsv`, rounded half up. 0 with no price or no sats. */
export const bsvCents = (sats: number, usdPerBsv: number): number => {
  const rate = microUsd(usdPerBsv);
  if (!rate || !Number.isFinite(sats) || sats <= 0) return 0;
  const s = BigInt(Math.round(sats));
  // cents = sats / 1e8 BSV × rate/1e6 $ × 100 = sats × rate / 1e12
  const unit = SATS_PER_BSV * 10_000n;
  return Number((s * rate + unit / 2n) / unit);
};

/** Whole cents for a dollar amount (MNEE and other dollar parts), half up. */
export const usdCents = (usd: number): number => (Number.isFinite(usd) ? Math.round(usd * 100) : 0);

/**
 * The headline balance in dollars, already rounded to the cent: BSV at `usdPerBsv` plus `extraUsd` (MNEE). Under a cent it
 * stays exact, so formatFiat's app-wide rule still shows 2 significant digits ("$0.0039", never "$0.00").
 */
export const balanceUsd = (sats: number, usdPerBsv: number, extraUsd = 0): number => {
  const exact =
    (Number.isFinite(sats) && sats > 0 && usdPerBsv > 0 ? (sats / 1e8) * usdPerBsv : 0) +
    (Number.isFinite(extraUsd) ? extraUsd : 0);
  if (exact > 0 && exact < 0.01) return exact;
  return (bsvCents(sats, usdPerBsv) + usdCents(extraUsd)) / 100;
};

/** The headline balance as shown ("$1.45"), in the display currency. The same string on every build. */
export const formatBalanceUsd = (sats: number, usdPerBsv: number, extraUsd = 0, fx?: Fx): string =>
  formatFiat(balanceUsd(sats, usdPerBsv, extraUsd), fx);

/** Satoshis from the BSV amount the wallet page keeps (sats / 1e8), exactly. */
export const satsOf = (bsv: number): number => (Number.isFinite(bsv) ? Math.round(bsv * 100_000_000) : 0);

/** "just now", "40 s ago", "5 min ago", "3 h ago": how old the price is. Empty with no price. */
export const rateAgeText = (ageMs: number | null): string => {
  if (ageMs === null || !Number.isFinite(ageMs)) return '';
  const s = Math.floor(Math.max(0, ageMs) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ago`;
};

/** The price line under the balance: "1 BSV = $15.17 · 40 s ago" (the age so a difference can be read). */
export const rateLine = (usdPerBsv: number, ageMs: number | null, fx?: Fx): string => {
  if (!(usdPerBsv > 0)) return '';
  const age = rateAgeText(ageMs);
  return `1 BSV = ${formatFiat(usdPerBsv, fx)}${age ? ` · ${age}` : ''}`;
};
