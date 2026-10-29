import { describe, expect, test } from 'bun:test';
import { dragSteps, loopOffset } from './swipe';

describe('loopOffset', () => {
  test('neighbours wrap around the loop', () => {
    expect(loopOffset(0, 0, 7)).toBe(0);
    expect(loopOffset(1, 0, 7)).toBe(1);
    expect(loopOffset(6, 0, 7)).toBe(-1);
    expect(loopOffset(0, 6, 7)).toBe(1);
  });
});

describe('dragSteps', () => {
  test('small slow drag snaps back', () => expect(dragSteps(-20, 0, 300)).toBe(0));
  test('past 20% steps one card', () => {
    expect(dragSteps(-80, 0, 300)).toBe(1);
    expect(dragSteps(80, 0, 300)).toBe(-1);
  });
  test('quick flick steps even when short', () => expect(dragSteps(-15, -0.8, 300)).toBe(1));
  test('a fast fling coasts but caps at 3', () => expect(dragSteps(-300, -9, 300)).toBe(3));
  test('never steps against the drag', () => expect(dragSteps(-10, 2, 300)).toBe(0));
});
