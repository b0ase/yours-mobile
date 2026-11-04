import { describe, expect, test } from 'bun:test';
import { nextTryText } from './moveToDevice';

describe('MoveToDeviceNotice (review 4 Nov 2026, F4)', () => {
  test('says when the next automatic try is', () => {
    expect(nextTryText(0, 1_000)).toMatch(/next time the wallet opens/);
    expect(nextTryText(1_000 + 4.5 * 60_000, 1_000)).toBe('It tries again on its own in about 5 min.');
  });
});
