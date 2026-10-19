import { expect, test } from 'bun:test';
import { withTimeout } from '../withTimeout';
import {
  balanceView,
  loadLastBalance,
  saveLastBalance,
  showSyncRetry,
  staleBalanceHint,
  loadLastBalanceAt,
} from './balanceLoad';

test('spinner only while the first load is in flight; never after a failure', () => {
  expect(balanceView({ loading: true, failed: false, known: false })).toBe('spinner');
  expect(balanceView({ loading: false, failed: true, known: false })).toBe('unknown');
  expect(balanceView({ loading: false, failed: true, known: true })).toBe('amount');
  expect(balanceView({ loading: false, failed: false, known: true })).toBe('amount');
});

test('withTimeout rejects a promise that never settles', async () => {
  await expect(withTimeout(new Promise(() => {}), 20, 'Balance')).rejects.toThrow(/Balance timed out/);
  expect(await withTimeout(Promise.resolve(7), 20)).toBe(7);
});

test('last balance cache round-trips per identity and ignores junk', () => {
  const store = new Map<string, string>();
  const g = globalThis as unknown as { localStorage?: unknown };
  const prev = g.localStorage;
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
  try {
    expect(loadLastBalance('1abc')).toBeNull();
    saveLastBalance('1abc', 6977);
    expect(loadLastBalance('1abc')).toBe(6977);
    expect(loadLastBalance('1other')).toBeNull();
    saveLastBalance('1abc', NaN);
    expect(loadLastBalance('1abc')).toBe(6977);
    store.set('bwallet.lastBalance.1abc', 'x');
    expect(loadLastBalance('1abc')).toBeNull();
    expect(loadLastBalance(undefined)).toBeNull();
  } finally {
    g.localStorage = prev;
  }
});

test('"Still syncing" only when nothing is known: a cached balance syncs quietly', () => {
  expect(showSyncRetry({ failed: true, known: true })).toBe(false);
  expect(showSyncRetry({ failed: true, known: false })).toBe(true);
  expect(showSyncRetry({ failed: false, known: false })).toBe(false);
});

test('stale hint: only for a cached amount while fresh loads fail', () => {
  const at = new Date(2026, 9, 19, 14, 5).getTime();
  const now = new Date(2026, 9, 19, 15, 0).getTime();
  expect(staleBalanceHint({ failed: true, known: true, fresh: false, at, now })).toContain('may be out of date');
  expect(staleBalanceHint({ failed: true, known: true, fresh: false, at, now })).toContain('Last updated');
  expect(staleBalanceHint({ failed: true, known: true, fresh: false, at: null })).toBe('May be out of date');
  expect(staleBalanceHint({ failed: false, known: true, fresh: false, at })).toBeNull();
  expect(staleBalanceHint({ failed: true, known: true, fresh: true, at })).toBeNull();
  expect(staleBalanceHint({ failed: true, known: false, fresh: false, at })).toBeNull();
});

test('cache time is per identity', () => {
  const store = new Map<string, string>();
  const g = globalThis as unknown as { localStorage?: unknown };
  const prev = g.localStorage;
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
  try {
    expect(loadLastBalanceAt('1a')).toBeNull();
    saveLastBalance('1a', 5);
    expect(loadLastBalanceAt('1a')).toBeGreaterThan(0);
    expect(loadLastBalanceAt('1b')).toBeNull();
    expect(loadLastBalance('1b')).toBeNull();
  } finally {
    g.localStorage = prev;
  }
});
