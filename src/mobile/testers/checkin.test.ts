import { describe, expect, test } from 'bun:test';
import { cleanLink, shouldCheckIn, testersEnabled } from './checkin';

describe('tester check-ins', () => {
  test('Play build only', () => {
    expect(testersEnabled('android-play')).toBe(true);
    expect(testersEnabled('android-direct')).toBe(false);
    expect(testersEnabled('ios-store')).toBe(false);
  });
  test('link: tester code or email, normalised', () => {
    expect(cleanLink(' bwt-7kq2-m9xa ')).toBe('BWT-7KQ2-M9XA');
    expect(cleanLink('Them@Gmail.com')).toBe('them@gmail.com');
    expect(cleanLink('hello')).toBe(null);
  });
  test('once a day, only when linked', () => {
    expect(shouldCheckIn(null, null, '2026-10-07')).toBe(false);
    expect(shouldCheckIn('BWT-AAAA-AAAA', null, '2026-10-07')).toBe(true);
    expect(shouldCheckIn('BWT-AAAA-AAAA', '2026-10-07', '2026-10-07')).toBe(false);
    expect(shouldCheckIn('BWT-AAAA-AAAA', '2026-10-06', '2026-10-07')).toBe(true);
  });
});
