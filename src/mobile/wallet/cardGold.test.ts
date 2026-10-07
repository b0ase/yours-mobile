import { describe, expect, test } from 'bun:test';
import { CARD_GOLD_HIDDEN, cardGold, cardGoldLevel } from './cardGold';

describe('cardGold', () => {
  test('boundaries', () => {
    expect(cardGold(0)).toBe(0);
    expect(cardGold(0.001)).toBe(0);
    expect(cardGold(0.0005)).toBe(0);
    expect(cardGold(100)).toBe(1);
    expect(cardGold(5000)).toBe(1);
    expect(cardGold(Infinity)).toBe(1);
  });
  test('documented points', () => {
    expect(cardGold(0.01)).toBeCloseTo(0.2, 6);
    expect(cardGold(0.1)).toBeCloseTo(0.4, 6);
    expect(cardGold(1)).toBeCloseTo(0.6, 6);
    expect(cardGold(10)).toBeCloseTo(0.8, 6);
  });
  test('negative and NaN → 0', () => {
    expect(cardGold(-1)).toBe(0);
    expect(cardGold(-Infinity)).toBe(0);
    expect(cardGold(NaN)).toBe(0);
  });
  test('monotonic and within 0..1', () => {
    let prev = -1;
    for (let e = -5; e <= 3; e += 0.01) {
      const g = cardGold(10 ** e);
      expect(g).toBeGreaterThanOrEqual(prev);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(1);
      prev = g;
    }
  });
  test('hidden balance uses a neutral value; unknown is black', () => {
    expect(cardGoldLevel(1000, { hidden: true })).toBe(CARD_GOLD_HIDDEN);
    expect(cardGoldLevel(0, { hidden: true })).toBe(CARD_GOLD_HIDDEN);
    expect(cardGoldLevel(1000, { known: false })).toBe(0);
    expect(cardGoldLevel(1, { known: true })).toBeCloseTo(0.6, 6);
  });
});
