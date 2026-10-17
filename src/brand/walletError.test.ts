import { expect, test } from 'bun:test';
import { describeWalletError } from './walletError';

test('review-actions errors carry the broadcast reason', () => {
  const e = Object.assign(new Error('Undelayed createAction or signAction results require review.'), {
    reviewActionResults: [{ txid: 'aa', status: 'doubleSpend', competingTxs: ['bbbbbbbbbbbbbbbbbbbbbbbb'] }],
  });
  expect(describeWalletError(e)).toContain('double spend');
  expect(describeWalletError(e)).toContain('competing bbbbbbbbbbbb');
  expect(describeWalletError(new Error('plain'))).toBe('plain');
  expect(describeWalletError('x')).toBe('x');
});
