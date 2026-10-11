import { describe, expect, test } from 'bun:test';
import { DEPOSIT_BASKET } from '@1sat/types';
import { balanceWithDeposits, depositBasketSats, sweepWaitingDeposits } from './depositBalance';

const wallet = (funded: number, deposits: number[], opts: { failList?: boolean } = {}) => ({
  balance: async () => funded,
  listOutputs: async ({ basket }: { basket: string }) => {
    if (opts.failList) throw new Error('storage busy');
    expect(basket).toBe(DEPOSIT_BASKET);
    return { totalOutputs: deposits.length, outputs: deposits.map((satoshis) => ({ satoshis, spendable: true })) };
  },
});

describe('balance with deposits', () => {
  test('a received but unswept payment counts (the $vexvoid case: new account, 25,432,350 sats)', async () => {
    expect(await balanceWithDeposits(wallet(0, [25_432_350]))).toBe(25_432_350);
  });
  test('adds deposits to the funding balance', async () => {
    expect(await balanceWithDeposits(wallet(1_000, [500, 250]))).toBe(1_750);
  });
  test('no deposits: just the funding balance', async () => {
    expect(await balanceWithDeposits(wallet(42, []))).toBe(42);
  });
  test('a failed deposit read does not hide the funding balance', async () => {
    expect(await balanceWithDeposits(wallet(42, [], { failList: true }))).toBe(42);
  });
  test('spent deposits are not counted', async () => {
    const w = {
      listOutputs: async () => ({
        totalOutputs: 2,
        outputs: [
          { satoshis: 100, spendable: true },
          { satoshis: 900, spendable: false },
        ],
      }),
    };
    expect(await depositBasketSats(w)).toBe(100);
  });
});

describe('sweep waiting deposits before createAction', () => {
  test('sweeps when the deposit basket holds money (vexvoid inscribe case)', async () => {
    let calls = 0;
    const n = await sweepWaitingDeposits(wallet(0, [670_198]), async () => (calls++, { swept: 1 }));
    expect(n).toBe(1);
    expect(calls).toBe(1);
  });
  test('does not sweep an empty deposit basket', async () => {
    let calls = 0;
    expect(await sweepWaitingDeposits(wallet(5, []), async () => (calls++, { swept: 0 }))).toBe(0);
    expect(calls).toBe(0);
  });
  test('a failed sweep or read never throws', async () => {
    expect(
      await sweepWaitingDeposits(wallet(0, [1]), async () => {
        throw new Error('broadcast');
      }),
    ).toBe(0);
    expect(await sweepWaitingDeposits(wallet(0, [], { failList: true }), async () => ({ swept: 1 }))).toBe(0);
  });
});
