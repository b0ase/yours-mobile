import { describe, expect, test } from 'bun:test';
import { nextTryText, RETRY_STILL_MOVING, retryButtonText, retryNote, shownRetryNote } from './moveToDevice';

describe('MoveToDeviceNotice (review 4 Nov 2026, F4)', () => {
  test('says when the next automatic try is', () => {
    expect(nextTryText(0, 1_000)).toMatch(/next time the wallet opens/);
    expect(nextTryText(1_000 + 4.5 * 60_000, 1_000)).toBe('It tries again on its own in about 5 min.');
  });
});

describe('Retry answers in about 2 s, then "Still moving: N of M" (5.2.62)', () => {
  test('the note after Retry: done, still moving, or not moved with the reason', () => {
    expect(retryNote({ success: true })).toBe('Done: this account is on this device now.');
    expect(retryNote({ success: false, error: 'Still moving: 3 of 9', data: { moving: true } })).toBe(
      RETRY_STILL_MOVING,
    );
    expect(retryNote({ success: false, error: 'backup short', data: { moving: false } })).toBe(
      'Not moved yet (backup short).',
    );
    expect(retryNote(undefined)).toBe('Not moved yet.');
  });

  test('the button counts while the move runs; the "still moving" note goes when it ends', () => {
    expect(retryButtonText(true, { moving: false })).toBe('Moving…');
    expect(retryButtonText(false, { moving: true, progress: { done: 3, total: 9 } })).toBe('Still moving: 3 of 9…');
    expect(retryButtonText(false, { moving: true, progress: null })).toBe('Still moving…');
    expect(retryButtonText(false, { moving: false })).toBe('Retry moving this account to this device');
    expect(shownRetryNote(RETRY_STILL_MOVING, true)).toBe(RETRY_STILL_MOVING);
    expect(shownRetryNote(RETRY_STILL_MOVING, false)).toBe('');
    expect(shownRetryNote('Not moved yet (x).', false)).toBe('Not moved yet (x).');
  });
});
