import { describe, expect, test } from 'bun:test';
import { NEVER_LOCK, isSessionExpired, lockTimeoutMinutes, lockTimeoutMs } from './lockTimeout';

const MIN = 60_000;
const NOW = 1_800_000_000_000;

describe('lock timeout', () => {
  test('new accounts (no setting) never lock', () => {
    expect(lockTimeoutMs(undefined)).toBe(NEVER_LOCK);
    expect(lockTimeoutMs({})).toBe(NEVER_LOCK);
    expect(lockTimeoutMs({ lockTimeout: null })).toBe(NEVER_LOCK);
  });
  test('0 means never', () => {
    expect(lockTimeoutMs({ lockTimeout: 0, lockTimeoutChosen: true })).toBe(NEVER_LOCK);
    expect(lockTimeoutMinutes({ lockTimeout: 0 })).toBe(0);
  });
  test('the old default 10 becomes never; a chosen 10 is kept', () => {
    expect(lockTimeoutMs({ lockTimeout: 10 })).toBe(NEVER_LOCK);
    expect(lockTimeoutMs({ lockTimeout: 10, lockTimeoutChosen: true })).toBe(10 * MIN);
  });
  test('other user-chosen minutes are kept and capped at 24 h', () => {
    expect(lockTimeoutMs({ lockTimeout: 5 })).toBe(5 * MIN);
    expect(lockTimeoutMs({ lockTimeout: 99999 })).toBe(1440 * MIN);
  });
  test('never: never expired, however long idle', () => {
    expect(isSessionExpired(NOW - 365 * 24 * 60 * MIN, NEVER_LOCK, NOW)).toBe(false);
  });
  test('never: a deliberate lock (lastActiveTime 0) stays locked', () => {
    expect(isSessionExpired(0, NEVER_LOCK, NOW)).toBe(true);
    expect(isSessionExpired(undefined, NEVER_LOCK, NOW)).toBe(true);
  });
  test('N minutes still locks', () => {
    expect(isSessionExpired(NOW - 4 * MIN, 5 * MIN, NOW)).toBe(false);
    expect(isSessionExpired(NOW - 5 * MIN, 5 * MIN, NOW)).toBe(true);
    expect(isSessionExpired(NOW - 60 * MIN, 5 * MIN, NOW)).toBe(true);
  });
});
