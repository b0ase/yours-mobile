import { describe, expect, test } from 'bun:test';
import { MAX_PULL, THRESHOLD, gestureIntent, rubberBand, shouldRefresh } from './pullMath';

describe('pull to refresh', () => {
  test('rubber band resists and caps', () => {
    expect(rubberBand(-10)).toBe(0);
    expect(rubberBand(20)).toBeLessThan(20);
    expect(rubberBand(140)).toBe(70);
    expect(rubberBand(10_000)).toBe(MAX_PULL);
  });
  test('threshold', () => {
    expect(shouldRefresh(THRESHOLD - 1)).toBe(false);
    expect(shouldRefresh(THRESHOLD)).toBe(true);
  });
  test('horizontal swipes and upward drags cancel', () => {
    expect(gestureIntent(2, 3)).toBe('undecided');
    expect(gestureIntent(30, 10)).toBe('cancel');
    expect(gestureIntent(0, -20)).toBe('cancel');
    expect(gestureIntent(3, 20)).toBe('pull');
  });
});
