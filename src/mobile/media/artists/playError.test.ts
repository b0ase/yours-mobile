import { describe, expect, test } from 'bun:test';
import { LOAD_FAILED, playErrorMessage } from './playError';

describe('playErrorMessage', () => {
  test('NotAllowedError means the browser blocked autoplay', () => {
    expect(playErrorMessage(new DOMException('x', 'NotAllowedError'))).toBe(
      'Your browser blocked playback — tap Play again',
    );
  });
  test('anything else is a generic failure', () => {
    expect(playErrorMessage(new Error('boom'))).toBe("Couldn't start playback — tap Play again");
    expect(playErrorMessage(undefined)).toBe("Couldn't start playback — tap Play again");
    expect(playErrorMessage(null)).toBe("Couldn't start playback — tap Play again");
  });
  test('load failure copy', () => {
    expect(LOAD_FAILED).toBe("This track didn't load. Try again.");
  });
});
