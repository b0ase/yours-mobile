import { describe, expect, test } from 'bun:test';
import { checkQuote } from './actions';
import type { PlacementQuote } from './api';
import type { Company, PlacementOffer } from './placement';

const T = '5221' + '00'.repeat(10) + 'ae';
const company = { name: 'Co', ticker: 'CO', treasury: { lockingScriptHex: T, m: 2, n: 3 } } as unknown as Company;
const offer = { id: 'o1', sats: 1000, shares: 10, status: 'accepted' } as unknown as PlacementOffer;
const q = (p: Partial<PlacementQuote> = {}): PlacementQuote => ({
  quote_id: 'q',
  expires_at: '',
  outputs: [{ lockingScript: T, satoshis: 1000 }],
  memo: 'bitsign-bshares n',
  memo_script: '006a11' + 'aa'.repeat(17),
  ...p,
});

describe('bShares memo-bound payment (audit M5)', () => {
  test('a good quote passes', () => expect(checkQuote(company, offer, q())).toBeNull());
  test('wrong treasury script is refused', () =>
    expect(checkQuote(company, offer, q({ outputs: [{ lockingScript: '76a9', satoshis: 1000 }] }))).not.toBeNull());
  test('wrong amount is refused', () =>
    expect(checkQuote(company, offer, q({ outputs: [{ lockingScript: T, satoshis: 999 }] }))).not.toBeNull());
  test('extra outputs are refused', () =>
    expect(checkQuote(company, offer, q({ outputs: [q().outputs[0], q().outputs[0]] }))).not.toBeNull());
  test('a non-data memo is refused', () =>
    expect(checkQuote(company, offer, q({ memo_script: '76a914' }))).not.toBeNull());
});
