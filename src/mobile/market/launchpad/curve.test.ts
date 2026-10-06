import { describe, expect, test } from 'bun:test';
import {
  GRAD_SOLD,
  HOUSE_BPS,
  ROUTE_BPS,
  SUPPLY,
  marketCap,
  poolSats,
  price,
  progress,
  quoteBuy,
  quoteSell,
} from './curve';
import { change24, sortBoard, type BoardCoin } from './api';

describe('BlastPad curve (ported)', () => {
  test('starts at ~0.093 sats a token, empty pool', () => {
    expect(poolSats(0n)).toBe(0n);
    expect(price(0n)).toBeCloseTo(0.0932, 3);
    expect(marketCap(0n) / 1e8).toBeCloseTo(0.932, 2);
    expect(progress(GRAD_SOLD)).toBe(1);
  });

  test('buy takes 1.0% in fees and the pool gets the rest', () => {
    const q = quoteBuy(0n, 1_000_000n);
    expect(q.houseFee).toBe((1_000_000n * HOUSE_BPS) / 10_000n);
    expect(q.routeFee).toBe((1_000_000n * ROUTE_BPS) / 10_000n);
    expect(q.curveSats).toBeLessThanOrEqual(990_000n);
    expect(q.curveSats).toBe(poolSats(q.tokens));
    expect(q.userSats).toBe(q.curveSats + q.houseFee + q.routeFee);
    expect(q.tokens).toBeGreaterThan(0n);
  });

  test('selling what you bought returns less than you paid (fees, rounding)', () => {
    const b = quoteBuy(100_000_000n, 5_000_000n);
    const s = quoteSell(b.soldAfter, b.tokens);
    expect(s.soldAfter).toBe(100_000_000n);
    expect(s.userSats).toBeLessThan(b.userSats);
    expect(s.userSats).toBe(s.curveSats - s.houseFee - s.routeFee);
  });

  test('never sells more than the supply or buys back more than sold', () => {
    expect(quoteBuy(SUPPLY - 10n, 2_000_000_000n).tokens).toBe(10n);
    expect(quoteSell(5n, 100n).tokens).toBe(5n);
  });
});

describe('board helpers', () => {
  const coin = (o: Partial<BoardCoin>) =>
    ({ sold: 0, sold24: 0, vol24: 0, trades24: 0, created_at: '2026-01-01', ...o }) as BoardCoin;
  test('24h change from price now vs price then', () => {
    expect(change24(coin({ sold: 0, sold24: 0 }))).toBe(0);
    expect(change24(coin({ sold: 100_000_000, sold24: 0 }))!).toBeGreaterThan(0);
    expect(change24(coin({ sold24: null }))).toBeNull();
  });
  test('sorted by volume, then trades, then newest', () => {
    const s = sortBoard([
      coin({ slot: 'a', vol24: 1 }),
      coin({ slot: 'b', vol24: 5 }),
      coin({ slot: 'c', vol24: 1, trades24: 3 }),
      coin({ slot: 'd', vol24: 1, created_at: '2026-05-01' }),
    ]);
    expect(s.map((c) => c.slot)).toEqual(['b', 'c', 'd', 'a']);
  });
});
