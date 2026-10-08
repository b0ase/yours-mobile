import { describe, expect, test } from 'bun:test';
import { levelToBars } from './levelMeter';

describe('levelToBars', () => {
  test('silence and junk give flat bars', () => {
    for (const l of [0, -1, Number.NaN]) expect(levelToBars(l)).toEqual([0.18, 0.18, 0.18, 0.18]);
  });
  test('loud audio fills the tallest bar, clamps above 1', () => {
    expect(Math.max(...levelToBars(1))).toBe(1);
    expect(levelToBars(5)).toEqual(levelToBars(1));
  });
  test('louder is never lower, quiet speech still moves', () => {
    const a = levelToBars(0.05);
    const b = levelToBars(0.3);
    a.forEach((h, i) => expect(b[i]).toBeGreaterThanOrEqual(h));
    expect(Math.max(...a)).toBeGreaterThan(0.4);
  });
  test('bar count is configurable', () => {
    expect(levelToBars(0.5, 5)).toHaveLength(5);
  });
});
