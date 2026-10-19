import { describe, expect, test } from 'bun:test';
import { isNetworkError } from './offline';

describe('isNetworkError', () => {
  test('fetch failures on each engine', () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isNetworkError(new TypeError('Load failed'))).toBe(true);
    expect(isNetworkError(new TypeError("Couldn't reach api.1sat.app (Failed to fetch). Check your connection."))).toBe(
      true,
    );
    expect(isNetworkError('net::ERR_NAME_NOT_RESOLVED')).toBe(true);
  });
  test('aborts and timeouts (what the Android phone stored)', () => {
    expect(isNetworkError('signal is aborted without reason')).toBe(true);
    expect(isNetworkError(new DOMException('x', 'AbortError'))).toBe(true);
    expect(isNetworkError(new DOMException('x', 'TimeoutError'))).toBe(true);
  });
  test('real faults are not network errors', () => {
    expect(isNetworkError(new Error('Insufficient funds'))).toBe(false);
    expect(isNetworkError('HTTP 500')).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
  });
});
