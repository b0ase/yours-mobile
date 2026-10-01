import { describe, expect, test } from 'bun:test';

(globalThis as Record<string, unknown>).__MARKET_FEE_ADDRESS__ = '';
const { marketFeeOptions, marketFeeSats } = await import('./fee');

// A well-known public address (the genesis coinbase), used only as valid input.
const ADDR = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';

describe('market fee', () => {
  test('no fee by default', () => {
    expect(marketFeeSats(10_000)).toBe(0);
    expect(marketFeeOptions()).toEqual({});
  });
  test('1% rounded up when an address is set', () => {
    expect(marketFeeSats(10_000, ADDR)).toBe(100);
    expect(marketFeeSats(150, ADDR)).toBe(2);
    expect(marketFeeOptions(ADDR)).toEqual({ marketplaceAddress: ADDR, marketplaceRate: 0.01 });
  });
  test('invalid address charges nothing', () => {
    expect(marketFeeSats(10_000, 'not-an-address')).toBe(0);
  });
});
