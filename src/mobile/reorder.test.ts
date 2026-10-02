import { describe, expect, test } from 'bun:test';
import { moveItem } from './reorder';

describe('moveItem', () => {
  const l = ['a', 'b', 'c', 'd'];
  test('moves forward', () => expect(moveItem(l, 0, 2)).toEqual(['b', 'c', 'a', 'd']));
  test('moves backward', () => expect(moveItem(l, 3, 1)).toEqual(['a', 'd', 'b', 'c']));
  test('same index is a copy', () => {
    const r = moveItem(l, 1, 1);
    expect(r).toEqual(l);
    expect(r).not.toBe(l);
  });
  test('clamps destination', () => {
    expect(moveItem(l, 0, 99)).toEqual(['b', 'c', 'd', 'a']);
    expect(moveItem(l, 2, -5)).toEqual(['c', 'a', 'b', 'd']);
  });
  test('out-of-range source is a no-op', () => expect(moveItem(l, 7, 0)).toEqual(l));
  test('does not mutate input', () => {
    moveItem(l, 0, 3);
    expect(l).toEqual(['a', 'b', 'c', 'd']);
  });
});
