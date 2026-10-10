import { describe, expect, test } from 'bun:test';
import { BACK_PNEE_ROUTE, backPneeSummary, isBackPneeMode, parseBsvAmount } from './backPnee';

describe('Back PNEEs entry', () => {
  test('route opens the lock screen in back mode', () => {
    expect(BACK_PNEE_ROUTE.startsWith('/m/lock')).toBe(true);
    expect(isBackPneeMode(BACK_PNEE_ROUTE.slice(BACK_PNEE_ROUTE.indexOf('?')))).toBe(true);
    expect(isBackPneeMode('')).toBe(false);
    expect(isBackPneeMode('?tx=abc')).toBe(false);
  });
  test('parses amounts', () => {
    expect(parseBsvAmount('1')).toBe(1);
    expect(parseBsvAmount(' 0,5 ')).toBe(0.5);
    expect(parseBsvAmount('.25')).toBe(0.25);
    expect(parseBsvAmount('0.00000001')).toBe(1e-8);
    expect(parseBsvAmount('0.000000001')).toBeNull();
    expect(parseBsvAmount('0')).toBeNull();
    expect(parseBsvAmount('')).toBeNull();
    expect(parseBsvAmount('-1')).toBeNull();
    expect(parseBsvAmount('abc')).toBeNull();
  });
  test('summary at 10x collateral', () => {
    expect(backPneeSummary(1, 50)).toEqual({ usd: 50, maxPneeUsd: 5 });
    expect(backPneeSummary(0.5, 33.33)).toEqual({ usd: 16.67, maxPneeUsd: 1.66 });
    expect(backPneeSummary(1, 0)).toEqual({ usd: 0, maxPneeUsd: 0 });
  });
});
