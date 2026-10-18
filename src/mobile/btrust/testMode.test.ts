import { expect, test } from 'bun:test';
import { btrustTestMode, testModeFor } from './testMode';

test('a production build ignores the URL param and localStorage', () => {
  expect(testModeFor({ dev: false, href: 'https://web.bwalletx.com/?btrust-test', flag: '1' })).toBe(false);
  expect(testModeFor({ dev: false, href: 'chrome-extension://x/index.html#btrust-test' })).toBe(false);
  expect(testModeFor({ dev: false, flag: '1' })).toBe(false);
});

test('a developer build turns on by URL or localStorage only', () => {
  expect(testModeFor({ dev: true, href: 'http://localhost:5173/?btrust-test' })).toBe(true);
  expect(testModeFor({ dev: true, flag: '1' })).toBe(true);
  expect(testModeFor({ dev: true, href: 'http://localhost:5173/', flag: null })).toBe(false);
});

test('outside a dev build (as here, DEV unset) the runtime check is off even with the flag set', () => {
  const g = globalThis as { localStorage?: unknown };
  const had = g.localStorage;
  g.localStorage = { getItem: () => '1' };
  try {
    expect(btrustTestMode()).toBe(false);
  } finally {
    g.localStorage = had;
  }
});
