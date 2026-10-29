import { describe, expect, test } from 'bun:test';
import { COIN_HISTORY_MESSAGE, WALLET_INTERNAL_MESSAGE, siteActionError } from './siteActionError';

const werr = (name: string, message: string) => Object.assign(new Error(message), { name, code: name });

describe('siteActionError', () => {
  test('bare WERR_INTERNAL: plain message, code kept', () => {
    const r = siteActionError(
      werr('WERR_INTERNAL', 'An internal error has occurred.'),
      'An internal error has occurred.',
    );
    expect(r).toEqual({ error: WALLET_INTERNAL_MESSAGE, code: 'WERR_INTERNAL' });
    expect(r.error).not.toMatch(/internal error has occurred/);
  });
  test("a coin's parent could not be loaded: coin-history message", () => {
    const e = werr(
      'WERR_INVALID_PARAMETER',
      `The txid ${'cd'.repeat(32)} parameter must be valid transaction on chain main`,
    );
    expect(siteActionError(e, e.message)).toEqual({ error: COIN_HISTORY_MESSAGE, code: 'WERR_INVALID_PARAMETER' });
  });
  test('network trouble: says so, nothing sent', () => {
    const r = siteActionError(new Error('Failed to fetch'), 'Failed to fetch');
    expect(r.error).toMatch(/Nothing was sent/);
    expect(r.code).toBeUndefined();
  });
  test('specific messages are left alone', () => {
    const e = werr('WERR_INSUFFICIENT_FUNDS', 'Insufficient funds');
    expect(siteActionError(e, 'Insufficient funds: this needs 5 sats')).toEqual({
      error: 'Insufficient funds: this needs 5 sats',
      code: 'WERR_INSUFFICIENT_FUNDS',
    });
  });
});
