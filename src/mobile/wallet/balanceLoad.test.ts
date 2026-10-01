import { expect, test } from 'bun:test';
import { withTimeout } from '../withTimeout';
import { balanceView, loadLastBalance, saveLastBalance } from './balanceLoad';

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
