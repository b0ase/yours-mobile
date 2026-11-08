import { describe, expect, test } from 'bun:test';
import { bsharesMemoScript, checkQuote, claimRawtx, payTreasury, payableProblem } from './actions';
import type { PlacementQuote } from './api';
import type { Company, PlacementOffer } from './placement';

const T = '5221' + '00'.repeat(10) + 'ae';
const company = { name: 'Co', ticker: 'CO', treasury: { lockingScriptHex: T, m: 2, n: 3 } } as unknown as Company;
const offer = { id: 'o1', sats: 1000, shares: 10, status: 'accepted' } as unknown as PlacementOffer;
// bit-sign memoScriptHex: OP_FALSE OP_RETURN <len> <utf8>, for a 16-char base64url nonce (32 bytes in all).
const MEMO = 'bitsign-bshares AbCdEfGhIjKlMnOp';
const MEMO_SCRIPT = '006a20' + Buffer.from(MEMO, 'utf8').toString('hex');
const q = (p: Partial<PlacementQuote> = {}): PlacementQuote => ({
  quote_id: 'q',
  expires_at: '',
  outputs: [{ lockingScript: T, satoshis: 1000 }],
  memo: MEMO,
  memo_script: MEMO_SCRIPT,
  ...p,
});

describe('bShares memo-bound payment (audit M5)', () => {
  test('a good quote passes', () => expect(checkQuote(company, offer, q())).toBeNull());
  test('upper-case hex is the same script', () =>
    expect(checkQuote(company, offer, q({ memo_script: MEMO_SCRIPT.toUpperCase() }))).toBeNull());
  test('wrong treasury script is refused', () =>
    expect(checkQuote(company, offer, q({ outputs: [{ lockingScript: '76a9', satoshis: 1000 }] }))).not.toBeNull());
  test('wrong amount is refused', () =>
    expect(checkQuote(company, offer, q({ outputs: [{ lockingScript: T, satoshis: 999 }] }))).not.toBeNull());
  test('extra outputs are refused', () =>
    expect(checkQuote(company, offer, q({ outputs: [q().outputs[0], q().outputs[0]] }))).not.toBeNull());
  test('a non-data memo is refused', () =>
    expect(checkQuote(company, offer, q({ memo_script: '76a914' }))).not.toBeNull());
});

describe('checkQuote: the memo script must be exactly the memo (review #7)', () => {
  test('bsharesMemoScript matches bit-sign memoScriptHex', () => expect(bsharesMemoScript(MEMO)).toBe(MEMO_SCRIPT));
  test('a data script that is not this memo is refused', () =>
    expect(checkQuote(company, offer, q({ memo_script: '006a11' + 'aa'.repeat(17) }))).toContain('memo script'));
  test('the memo with extra data after it is refused', () =>
    expect(checkQuote(company, offer, q({ memo_script: MEMO_SCRIPT + '01ff' }))).not.toBeNull());
  test('bare OP_RETURN (no OP_FALSE) is refused', () =>
    expect(checkQuote(company, offer, q({ memo_script: MEMO_SCRIPT.slice(2) }))).not.toBeNull());
  test('a memo without the bitsign-bshares prefix is refused', () => {
    const memo = 'bitsign-speak AbCdEfGhIjKlMnOp';
    expect(checkQuote(company, offer, q({ memo, memo_script: bsharesMemoScript(memo)! }))).toContain('bShares memo');
  });
  test('a memo over 75 bytes cannot be a single push', () => expect(bsharesMemoScript('x'.repeat(76))).toBeNull());
});

describe('payTreasury (review #2, #8)', () => {
  const ctx = (tx?: number[]) => {
    const seen: unknown[] = [];
    return {
      seen,
      ctx: {
        wallet: {
          createAction: async (a: unknown) => (seen.push(a), { txid: 'AB'.repeat(32), tx }),
        },
      } as never,
    };
  };
  test('broadcasts now, labelled, memo exactly the quote; returns the lower-case txid and the BEEF hex', async () => {
    const c = ctx([1, 2, 254]);
    const r = await payTreasury(c.ctx, company, offer, q());
    expect(r).toEqual({ txid: 'ab'.repeat(32), rawtx: '0102fe' });
    expect(c.seen[0]).toMatchObject({
      labels: ['bshares'],
      options: { acceptDelayedBroadcast: false, randomizeOutputs: false },
      outputs: [
        { lockingScript: T, satoshis: 1000 },
        { lockingScript: MEMO_SCRIPT, satoshis: 0 },
      ],
    });
  });
  test('only an accepted offer is paid, as the page shows Pay only then', async () => {
    const c = ctx();
    const offered = { ...offer, status: 'offered' } as PlacementOffer;
    expect(payableProblem(company, offered, q())).toBe('Accept the offer first');
    await expect(payTreasury(c.ctx, company, offered, q())).rejects.toThrow('Accept the offer first');
    expect(c.seen.length).toBe(0);
  });
  test('a bad quote never reaches the wallet', async () => {
    const c = ctx();
    await expect(payTreasury(c.ctx, company, offer, q({ memo_script: '006a00' }))).rejects.toThrow();
    expect(c.seen.length).toBe(0);
  });
  test('claimRawtx: none without a tx', () => expect(claimRawtx(undefined)).toBeUndefined());
});
