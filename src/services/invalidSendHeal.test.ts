import { describe, expect, test } from 'bun:test';
import { healInvalidSend, healMessage, isInvalidTxReview, namedSpentInputs, provenSpent } from './invalidSendHeal';

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
  test('a failed lookup leaves only that input alone', async () => {
    const r = await provenSpent([`${T('1')}_0`, `${T('2')}_0`], async (o) => {
      if (o.startsWith('2')) throw new Error('timeout');
      return T('9');
    });
    expect(r).toEqual([`${T('1')}_0`]);
  });
  test('asks the fallback (mempool) when the index names no spender', async () => {
    const r = await provenSpent(
      [`${T('1')}_0`],
      async () => null,
      async () => T('8'),
    );
    expect(r).toEqual([`${T('1')}_0`]);
  });
  test('junk answers and the rejected tx itself are not proof', async () => {
    expect(await provenSpent([`${T('1')}_0`], async () => 'spent')).toEqual([]);
    expect(await provenSpent([`${T('1')}_0`], async () => T('a'), undefined, T('a'))).toEqual([]);
  });
});

describe('namedSpentInputs', () => {
  test('takes inputs the broadcaster names after UTXO_SPENT', () => {
    const inputs = [`${T('1')}_0`, `${T('2')}_3`];
    expect(
      namedSpentInputs(`UTXO_SPENT (70): [ProcessTransaction][${T('a')}] utxo ${T('2')}:3 already spent`, inputs),
    ).toEqual([`${T('2')}_3`]);
    expect(namedSpentInputs(`SCRIPT_FAILED ${T('2')}:3`, inputs)).toEqual([]);
    expect(namedSpentInputs(undefined, inputs)).toEqual([]);
  });
});

describe('healInvalidSend', () => {
  test('ignores other failures', async () => {
    const r = await healInvalidSend(review('doubleSpend'), async () => T('9'), { markSpent: async () => 1 });
    expect(r).toEqual({ checked: 0, released: 0 });
  });
  test('no tx bytes: nothing to check', async () => {
    const r = await healInvalidSend(review('invalidTx'), async () => T('9'), { markSpent: async () => 1 });
    expect(r).toEqual({ checked: 0, released: 0, inputs: [] });
  });
});

describe('healMessage', () => {
  test('says nothing when nothing changed', () => {
    expect(healMessage({ checked: 2, released: 0 })).toBe('');
    expect(healMessage({ checked: 1, released: 0, inputs: [`${T('1')}_3`] })).toBe(
      ` Coins tried: ${T('1').slice(0, 10)}…:3.`,
    );
    expect(healMessage({ checked: 2, released: 2 })).toBe(
      ' 2 coins were already spent elsewhere (another device?); cleared — tap Send again.',
    );
  });
});
