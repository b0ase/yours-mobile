import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { balanceUsd, bsvCents, formatBalanceUsd, rateAgeText, rateLine, satsOf } from './balanceUsd';
import { formatUSD } from './format';

const USD = { currency: 'USD' as const, usdPerUnit: 1 };
const root = join(import.meta.dir, '..', '..');
const src = (p: string) => readFileSync(join(root, p), 'utf8');

describe('one dollar figure on every build (owner, 13 Nov 2026: "one penny different… not acceptable")', () => {
  test("the owner's balance: 9,532,114 sats at $15.17", () => {
    expect(bsvCents(9_532_114, 15.17)).toBe(145); // 1.44602169…
    expect(formatBalanceUsd(9_532_114, 15.17, 0, USD)).toBe('$1.45');
  });

  test('the extension headline and the phone card give the same string for the same sats and price', () => {
    for (const [sats, rate, mnee] of [
      [9_532_114, 15.17, 0],
      [9_532_115, 15.17, 0],
      [1_050_000, 10, 0], // exactly half a cent over: rounds up on both
      [123_456_789, 47.31, 2.5],
      [35_000_000, 15.18, 0.004],
      [22_000, 17.5, 0], // under a cent: 2 significant digits, never "$0.00"
      [2_100_000_000_000_000, 15.17, 0], // every bitcoin: no float loss
    ] as const) {
      const bsvBalance = sats / 100_000_000; // what BsvWallet keeps in state
      // Extension (pages/BsvWallet.tsx headline):
      const extension = formatBalanceUsd(satsOf(bsvBalance), rate, mnee, USD);
      // Phone (vite.config.mobile.ts passes usd=balanceUsd(...) to WalletCard, which shows formatUSD(animUsd), settled = usd):
      const phone = formatUSD(balanceUsd(satsOf(bsvBalance), rate, mnee));
      expect(phone).toBe(extension);
    }
  });

  test('rounds half up, once, in whole cents', () => {
    expect(bsvCents(1_050_000, 10)).toBe(11); // $0.105
    expect(bsvCents(1_049_999, 10)).toBe(10);
    expect(balanceUsd(1_050_000, 10, 0)).toBe(0.11);
    expect(balanceUsd(9_532_114, 15.17, 1.006)).toBe(2.46);
    expect(bsvCents(0, 15)).toBe(0);
    expect(bsvCents(100, 0)).toBe(0);
    expect(balanceUsd(22_000, 17.5)).toBeCloseTo(0.00385, 10);
  });

  test('the price age reads plainly', () => {
    expect(rateAgeText(null)).toBe('');
    expect(rateAgeText(2_000)).toBe('just now');
    expect(rateAgeText(40_000)).toBe('40 s ago');
    expect(rateAgeText(5 * 60_000)).toBe('5 min ago');
    expect(rateAgeText(3 * 3_600_000)).toBe('3 h ago');
    expect(rateLine(15.17, 40_000, USD)).toBe('1 BSV = $15.17 · 40 s ago');
    expect(rateLine(0, 40_000, USD)).toBe('');
  });

  test('both UIs use it: the extension headline, the phone card and its count-up', () => {
    const page = src('src/pages/BsvWallet.tsx');
    // the headline uses the shared display price; dollar SENDS use the payment rate read at send time
    expect(page).toContain('formatBalanceUsd(satsOf(bsvBalance), headlineRate, services.mnee ? mneeBalance : 0)');
    expect(page).toContain('fetchDisplayRate(apiContext.chain, apiContext.wocApiKey)');
    expect(page).toContain('(r.usdSendAmount / payRate) * BSV_DECIMAL_CONVERSION');
    expect(page).not.toContain('formatUSD(bsvBalance * exchangeRate');
    expect(page).toContain('startAlignedRateRefresh(');
    const mobile = src('vite.config.mobile.ts');
    expect(mobile).toContain(
      '<WalletCard usd={balanceUsd(satsOf(bsvBalance), headlineRate, services.mnee ? mneeBalance : 0)} sats={satsOf(bsvBalance)}',
    );
    expect(mobile).not.toContain('usd={bsvBalance * exchangeRate');
    expect(mobile).toContain('refreshing={isRefreshing} rate={headlineRate} /></HomeTop></SectionBoundary>');
    const card = src('src/mobile/wallet/WalletCard.tsx');
    expect(card).toContain('bsvCents(animSats, rate) - bsvCents(sats, rate)');
    expect(card).not.toContain('((animSats - sats) * rate) / 100_000_000');
  });
});
