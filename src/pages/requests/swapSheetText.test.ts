import { describe, expect, test } from 'bun:test';
import { swapSheetRows } from './swapSheetText';

const base = {
  terms: { ref: 'doc-1', docHash: 'ab'.repeat(32), tokenId: 'aa'.repeat(32) + '_0', amount: '100', priceUsd: 1 },
  symbol: 'TEST',
  tokens: '100',
  priceSats: 4_000_000,
  usdAtRate: 1,
  rate: 25,
  rateSource: 'feed',
  overlayFeeSats: 1000,
  split: false,
};

describe('swap sheet', () => {
  test('buyer sees BSV and USD, the rate and its source', () => {
    const t = swapSheetRows({ ...base, side: 'accept' });
    const rows = Object.fromEntries(t.rows);
    expect(rows['You pay']).toBe('0.04000000 BSV ($1.00)');
    expect(rows['Rate']).toBe('$25.00 per BSV (feed)');
    expect(rows['Indexing fee']).toBe('0.00001000 BSV');
    expect(t.action).toBe('Pay and swap');
  });
  test('seller is told about the set-aside send', () => {
    expect(swapSheetRows({ ...base, side: 'offer', split: true }).note).toMatch(/sets aside exactly 100 \$TEST/);
  });
});
