import { describe, expect, test } from 'bun:test';
import { joinPhrases, readOnlyProtocolPhrase, spendAmount } from './protocols';

describe('read-only protocol wording', () => {
  test('identity key retrieval is read-only, anything else is not', () => {
    expect(readOnlyProtocolPhrase([1, 'identity key retrieval'])).toBe('see your public ID');
    expect(readOnlyProtocolPhrase([1, ' Identity Key Retrieval '])).toBe('see your public ID');
    expect(readOnlyProtocolPhrase([2, 'wallet payment'])).toBeUndefined();
    expect(readOnlyProtocolPhrase(undefined)).toBeUndefined();
  });
  test('joinPhrases', () => {
    expect(joinPhrases(['a'])).toBe('a');
    expect(joinPhrases(['a', 'b', 'c'])).toBe('a, b and c');
  });
});

describe('spendAmount', () => {
  test('cents on top, sats under', () => {
    expect(spendAmount(20_000, 50)).toEqual({ primary: '1¢', secondary: '20,000 sats' });
    expect(spendAmount(1_000_000, 50)).toEqual({ primary: '50¢', secondary: '1,000,000 sats' });
    expect(spendAmount(100_000_000, 50)).toEqual({ primary: '$50.00', secondary: '100,000,000 sats' });
    expect(spendAmount(10, 50)).toEqual({ primary: 'under 1¢', secondary: '10 sats' });
  });
  test('no price: sats only', () => {
    expect(spendAmount(55_000, 0)).toEqual({ primary: '55,000 sats', secondary: null });
  });
});
