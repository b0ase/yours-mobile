import { describe, expect, test } from 'bun:test';
import { stableOrder } from './listOrder';

describe('stableOrder', () => {
  test('known rows keep their positions; new rows go on top; gone rows drop', () => {
    expect(stableOrder(['a', 'b', 'c'], ['c', 'd', 'a'], (x) => x)).toEqual(['d', 'a', 'c']);
  });
});
