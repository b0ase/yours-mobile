import { expect, test } from 'bun:test';
import { skinFor } from './cardSkins';
import { PATTERNS } from './cardPatterns';
import { _resetBalances, lastBalance, publishBalance } from './balanceStore';

test('known cards get hand-picked skins; others a stable valid one', () => {
  expect(skinFor('bsv').pattern).toBe('guilloche');
  const a = skinFor('sh-acme', '#2a2350');
  expect(skinFor('sh-acme', '#2a2350')).toEqual(a);
  for (const id of ['x', 'y', 'tok-1', 'sh-teapot', 'b-tokens'])
    expect(PATTERNS.some((p) => p.id === skinFor(id).pattern)).toBe(true);
});

test('balance store keeps the last value and ignores repeats', () => {
  _resetBalances();
  expect(lastBalance('bsv')).toBeNull();
  publishBalance('bsv', 0.5, 'BSV');
  const first = lastBalance('bsv');
  publishBalance('bsv', 0.5, 'BSV');
  expect(lastBalance('bsv')).toBe(first);
  publishBalance('bsv', Number.NaN, 'BSV');
  expect(lastBalance('bsv')?.amount).toBe(0.5);
});
