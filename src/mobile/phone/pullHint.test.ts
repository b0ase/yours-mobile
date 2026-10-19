import { describe, expect, test } from 'bun:test';
import { nextPullHint, PULL_HINT_SHOWS, pullHintApplies } from './pullHint';

describe('pull-to-b hint', () => {
  test('shows a few times, then stops', () => {
    let stored: string | null = null;
    for (let i = 0; i < PULL_HINT_SHOWS; i++) {
      const r = nextPullHint(stored);
      expect(r.show).toBe(true);
      stored = r.next;
    }
    expect(nextPullHint(stored).show).toBe(false);
  });
  test('never again once the person has pulled', () => {
    expect(nextPullHint('done')).toEqual({ show: false, next: 'done' });
  });
});

describe('where the pull hint may show', () => {
  test('only on an app screen with a touch screen (never over onboarding, never for a mouse)', () => {
    expect(pullHintApplies(true, true)).toBe(true);
    expect(pullHintApplies(false, true)).toBe(false);
    expect(pullHintApplies(true, false)).toBe(false);
  });
});
