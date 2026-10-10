import { describe, expect, test } from 'bun:test';
import { ERROR_MIN_MS, snackbarDuration } from './snackbarTiming';

describe('snackbarDuration', () => {
  test('errors stay at least long enough to read and copy', () => {
    expect(snackbarDuration('error', undefined, 3000)).toBe(ERROR_MIN_MS);
    expect(snackbarDuration('error', 2000, 3000)).toBe(ERROR_MIN_MS);
    expect(snackbarDuration('error', 15000, 3000)).toBe(15000);
  });
  test('success and info keep the requested or default time', () => {
    expect(snackbarDuration('success', undefined, 3000)).toBe(3000);
    expect(snackbarDuration('info', 1500, 3000)).toBe(1500);
  });
});
