import { describe, expect, test } from 'bun:test';
import { fiatToUsd, formatFiat, usdToFiat, type Fx } from './displayCurrency';
import { parseAmount } from '../mobile/wallet/send/sendLogic';

const USD: Fx = { currency: 'USD', usdPerUnit: 1 };
const GBP: Fx = { currency: 'GBP', usdPerUnit: 1.25 };

describe('display currency', () => {
  test('USD formats as before', () => {
    expect(formatFiat(1234.5, USD)).toBe('$1,234.50');
    expect(formatFiat(0.0006, USD, { small: true })).toBe('$0.0006');
    expect(formatFiat(0.01, USD, { approx: true })).toBe('$0.01');
  });
  test('GBP converts with en-GB formatting', () => {
    expect(formatFiat(12.5, GBP)).toBe('£10.00');
    expect(formatFiat(2500, GBP)).toBe('£2,000.00');
    expect(formatFiat(-2.5, GBP)).toBe('-£2.00');
    expect(formatFiat(0.01, GBP, { approx: true })).toBe('≈ £0.01');
    expect(formatFiat(250, GBP, { wholeAbove100: true })).toBe('£200');
  });
  test('quick chips: £5 → dollars → sats round-trips', () => {
    const usd = fiatToUsd(5, GBP);
    expect(usd).toBe(6.25);
    expect(usdToFiat(usd, GBP)).toBe(5);
    const rate = 25; // $ per BSV
    expect(Math.round((usd / rate) * 1e8)).toBe(25_000_000);
  });
  test('typed amounts accept £', () => {
    expect(parseAmount('£5.50')).toBe(5.5);
  });
  test('non-finite is blank', () => {
    expect(formatFiat(NaN, GBP)).toBe('');
  });
});
