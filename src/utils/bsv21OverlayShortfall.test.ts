import { describe, expect, test } from 'bun:test';
import { classifyBsv21Shortfall } from './bsv21OverlayShortfall';

describe('classifyBsv21Shortfall', () => {
  test('outputs the overlay has not seen yet are unseen, not invalid', () => {
    expect(classifyBsv21Shortfall([{ amount: 20_999_000n, state: 'unknown' }], 1000n)).toBe('unseen');
    expect(classifyBsv21Shortfall([{ amount: 500n, state: 'valid' }, { amount: 600n }], 1000n)).toBe('unseen');
  });

  test('queued covers the shortfall', () => {
    expect(classifyBsv21Shortfall([{ amount: 400n, state: 'valid' }, { amount: 600n, state: 'queued' }], 1000n)).toBe(
      'queued',
    );
  });

  test('outputs the overlay says are already spent mean a stale local list', () => {
    // TERANODE, 7 Oct 2026: the wallet still listed the spent deploy output (21M)
    // instead of the valid change 75f04ce8…_1, and the user saw "Tokens not validated".
    expect(classifyBsv21Shortfall([{ amount: 21_000_000n, state: 'spent' }], 1000n)).toBe('stale');
    expect(classifyBsv21Shortfall([{ amount: 400n, state: 'valid' }, { amount: 5000n, state: 'spent' }], 1000n)).toBe(
      'stale',
    );
  });

  test('invalid outputs are not-valid', () => {
    expect(classifyBsv21Shortfall([{ amount: 5000n, state: 'invalid' }], 1000n)).toBe('not-valid');
    expect(classifyBsv21Shortfall([{ amount: 100n, state: 'unknown' }], 1000n)).toBe('not-valid');
  });
});
