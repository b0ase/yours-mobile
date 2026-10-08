import { describe, expect, test } from 'bun:test';
import { deviceName, requestSignIns, signInRow, takeSignInsRequest } from './signIns';

describe('Recent sign-ins', () => {
  test('device names', () => {
    expect(deviceName('ios-app')).toBe('iPhone app');
    expect(deviceName('android-app')).toBe('Android app');
    expect(deviceName('weird')).toBe('Browser');
  });
  test('row text marks a new account and formats the time', () => {
    const r = signInRow({ at: '2026-10-08T14:05:00Z', device: 'browser', newAccount: true }, 'en-GB');
    expect(r.title).toBe('Browser · new account');
    expect(r.when).toContain('Oct');
    expect(signInRow({ at: 'nope', device: 'ios-app', newAccount: false }).when).toBe('');
  });
  test('a push tap request is taken once', () => {
    requestSignIns();
    expect(takeSignInsRequest()).toBe(true);
    expect(takeSignInsRequest()).toBe(false);
  });
});
