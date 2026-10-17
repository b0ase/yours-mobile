import { describe, expect, test } from 'bun:test';
import { healInvalidSend, healMessage, isInvalidTxReview, provenSpent } from './invalidSendHeal';

const T = (c: string) => c.repeat(64);
const review = (status: string) =>
  Object.assign(new Error('Undelayed createAction or signAction results require review.'), {
    name: 'WERR_REVIEW_ACTIONS',
    reviewActionResults: [{ txid: T('a'), status }],
  });

describe('isInvalidTxReview', () => {
  test('only invalidTx counts', () => {
    expect(isInvalidTxReview(review('invalidTx'))).toBe(true);
    expect(isInvalidTxReview(review('doubleSpend'))).toBe(false);
    expect(isInvalidTxReview(new Error('x'))).toBe(false);
    expect(isInvalidTxReview('invalidTx')).toBe(false);
  });
});

describe('provenSpent', () => {
  test('keeps only outpoints with a spending txid', async () => {
    const spend: Record<string, string | null> = { [`${T('1')}_0`]: T('9'), [`${T('2')}_1`]: null };
    expect(await provenSpent(Object.keys(spend), async (o) => spend[o])).toEqual([`${T('1')}_0`]);
  });
  test('any failed lookup releases nothing', async () => {
    const r = await provenSpent([`${T('1')}_0`, `${T('2')}_0`], async (o) => {
      if (o.startsWith('2')) throw new Error('timeout');
      return T('9');
    });
    expect(r).toBeNull();
  });
  test('junk answers are not proof', async () => {
    expect(await provenSpent([`${T('1')}_0`], async () => 'spent')).toEqual([]);
  });
});

describe('healInvalidSend', () => {
  test('ignores other failures', async () => {
    const r = await healInvalidSend(review('doubleSpend'), async () => T('9'), { markSpent: async () => 1 });
    expect(r).toEqual({ checked: 0, released: 0 });
  });
  test('no tx bytes: nothing to check', async () => {
    const r = await healInvalidSend(review('invalidTx'), async () => T('9'), { markSpent: async () => 1 });
    expect(r).toEqual({ checked: 0, released: 0 });
  });
});

describe('healMessage', () => {
  test('says nothing when nothing changed', () => {
    expect(healMessage({ checked: 2, released: 0 })).toBe('');
    expect(healMessage({ checked: 2, released: 2 })).toContain('2 coins were already spent elsewhere; they are now cleared');
  });
});
