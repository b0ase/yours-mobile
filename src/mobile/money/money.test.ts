import { describe, expect, test } from 'bun:test';
import { fmtUsd, money, moneyWithSats, parseUsdInput, satsNote, satsToUsd, usdToSats } from './money';

describe('money', () => {
  test('fmtUsd: cents, thousands, sub-cent', () => {
    expect(fmtUsd(0.01)).toBe('$0.01');
    expect(fmtUsd(1234.5)).toBe('$1,234.50');
    expect(fmtUsd(0)).toBe('$0.00');
    expect(fmtUsd(0.0006)).toBe('$0.0006');
    expect(fmtUsd(0.00064)).toBe('$0.0006');
    expect(fmtUsd(0.005)).toBe('$0.005');
  });
  test('sats <-> usd', () => {
    expect(satsToUsd(20_000, 50)).toBeCloseTo(0.01, 10);
    expect(satsToUsd(1, 0)).toBeNull();
    expect(usdToSats(0.01, 50)).toBe(20_000);
    expect(usdToSats(0.01, 30)).toBe(33_334);
    expect(usdToSats(1, 0)).toBeNull();
    expect(usdToSats(0, 50)).toBeNull();
  });
  test('money falls back to sats without a rate', () => {
    expect(money(20_000, 50)).toBe('$0.01');
    expect(money(20_000, 0)).toBe('20,000 sats');
    expect(satsNote(20_000, 50)).toBe('≈ 20,000 sats');
    expect(satsNote(20_000, 0)).toBe('');
    expect(moneyWithSats(20_000, 50)).toBe('$0.01 (20,000 sats)');
    expect(moneyWithSats(20_000, NaN)).toBe('20,000 sats');
  });
  test('parseUsdInput', () => {
    expect(parseUsdInput('$1.25')).toBe(1.25);
    expect(parseUsdInput('0.5')).toBe(0.5);
    expect(parseUsdInput('.05')).toBe(0.05);
    expect(parseUsdInput('1,000')).toBe(1000);
    expect(parseUsdInput('1.234')).toBeNull();
    expect(parseUsdInput('0')).toBeNull();
    expect(parseUsdInput('abc')).toBeNull();
    expect(parseUsdInput('')).toBeNull();
  });
});
