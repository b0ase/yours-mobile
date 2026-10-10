import { describe, expect, test } from 'bun:test';
import { DEPOSIT_BASKET } from '@1sat/types';
import { balanceWithDeposits, depositBasketSats } from './depositBalance';

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
