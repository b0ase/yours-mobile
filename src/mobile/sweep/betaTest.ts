/**
 * Beta "test with a small amount first" rules (owner, 15 Oct 2026). Pure so the threshold and the
 * test-amount coin choice are tested. Warnings come BEFORE money moves, never after.
 *  - A sweep over about £500 gets a sheet offering a small test sweep first.
 *  - Rates: `usdPerBsv` from fetchExchangeRate, `usdPerGbp` from the Bank of England cache. When the BSV
 *    rate is unknown we fall back to a sats threshold at a deliberately high BSV price, so we warn early.
 *  - The test amount is the larger of 1% of the total and about £10.
 *  - The test sweep spends only the smallest coins that add up to the test amount.
 */
import { APP_NAME } from '../storeBuild';

export const BETA_LIMIT_GBP = 500;
export const TEST_MIN_GBP = 10;
export const TEST_FRACTION = 0.01;

/** Used when no USD/GBP rate is cached. */
export const FALLBACK_USD_PER_GBP = 1.3;
/** Assumed BSV price when the live rate is unknown: high on purpose, so the sats threshold stays low. */
export const CONSERVATIVE_USD_PER_BSV = 200;

const SATS_PER_BSV = 100_000_000;
const ok = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** Whole sats worth `gbp` pounds. Unknown BSV rate → the conservative price. */
export const gbpToSats = (gbp: number, usdPerBsv: number, usdPerGbp?: number | null): number => {
  const fx = ok(usdPerGbp) ? usdPerGbp : FALLBACK_USD_PER_GBP;
  const bsv = ok(usdPerBsv) ? usdPerBsv : CONSERVATIVE_USD_PER_BSV;
  return Math.floor(((gbp * fx) / bsv) * SATS_PER_BSV);
};

/** True when `sats` is over about £500. */
export const overBetaLimit = (sats: number, usdPerBsv: number, usdPerGbp?: number | null): boolean =>
  sats > gbpToSats(BETA_LIMIT_GBP, usdPerBsv, usdPerGbp);

/** Target for a test sweep: the larger of 1% of the total and about £10, never more than the total. */
export const testTargetSats = (totalSats: number, usdPerBsv: number, usdPerGbp?: number | null): number =>
  Math.min(totalSats, Math.max(Math.ceil(totalSats * TEST_FRACTION), gbpToSats(TEST_MIN_GBP, usdPerBsv, usdPerGbp)));

/**
 * The smallest coins that add up to at least `target`. Returns null when a test sweep would not be
 * smaller than the whole (one coin, or the smallest coins already make up everything), since a "test"
 * that moves everything is not a test.
 */
export function pickTestInputs<T extends { satoshis: number }>(inputs: readonly T[], target: number): T[] | null {
  if (inputs.length < 2) return null;
  const sorted = [...inputs].sort((a, b) => a.satoshis - b.satoshis);
  const out: T[] = [];
  let sum = 0;
  for (const i of sorted) {
    if (sum >= target && out.length) break;
    out.push(i);
    sum += i.satoshis;
  }
  return out.length < inputs.length ? out : null;
}

export const BETA_LINE = 'Beta: test with a small amount first.';
export const BETA_SWEEP_TEXT = `${APP_NAME} is in beta. Sweep a small test amount first. Once it shows and you’ve sent some back out, sweep the rest.`;
export const BETA_RESTORE_TEXT = `${APP_NAME} is in beta. Try it with a small amount before moving your main funds here.`;
