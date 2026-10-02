import { describe, expect, test } from 'bun:test';
import { isFundsError } from './claimPersonal';

describe('sponsored first mint', () => {
  test('only an out-of-funds failure asks bCorp to sponsor', () => {
    expect(isFundsError('Insufficient funds')).toBe(true);
    expect(isFundsError('not enough sats to cover fee')).toBe(true);
    expect(isFundsError('No UTXOs available')).toBe(true);
    expect(isFundsError('Token deploy failed')).toBe(false);
    expect(isFundsError('user-rejected')).toBe(false);
    expect(isFundsError(undefined)).toBe(false);
  });
});
