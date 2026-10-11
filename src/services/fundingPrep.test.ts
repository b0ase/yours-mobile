import { describe, expect, test } from 'bun:test';
import { DEPOSIT_BASKET } from '@1sat/types';
import {
  type DepositOutput,
  depositBreakdown,
  type FundingSnapshot,
  insufficientFundsMessage,
  isInsufficientFunds,
  prepareFunding,
} from './fundingPrep';

const KEYED = JSON.stringify({ keyID: '0' });

function makeWallet(state: { funded: number; deposits: DepositOutput[] }) {
  return {
    balance: async () => state.funded,
    listOutputs: async ({ basket }: { basket: string }) => {
      expect(basket).toBe(DEPOSIT_BASKET);
      return { totalOutputs: state.deposits.length, outputs: state.deposits };
    },
  };
}

const VEXVOID_RAW =
  'Insufficient funds in the available inputs to cover the cost of the required outputs and the transaction fee (670198 more satoshis are needed, for a total of 670198), plus whatever would be required in order to pay the fee to unlock and spend the outputs used to provide the additional satoshis.';

describe('deposit breakdown', () => {
  test('splits deposits by what the sweep will do', async () => {
    const future = Date.now() + 60_000;
    const b = await depositBreakdown(
      makeWallet({
        funded: 0,
        deposits: [
          { satoshis: 100, spendable: true, customInstructions: KEYED },
          { satoshis: 40, spendable: true, customInstructions: KEYED, tags: [`hold:${future}`] },
          { satoshis: 7, spendable: true },
          { satoshis: 3, spendable: true, customInstructions: '{not json' },
          { satoshis: 900, spendable: false, customInstructions: KEYED },
        ],
      }),
    );
    expect(b).toEqual({ sweepable: 100, held: 40, unsweepable: 10 });
  });
});

describe('prepare funding before a site createAction', () => {
  test('detection only: never sweeps or credits, even with deposits and arriving money', async () => {
    let calls = 0;
    const snap = await prepareFunding({
      wallet: makeWallet({
        funded: 0,
        deposits: [{ satoshis: 25_000_000, spendable: true, customInstructions: KEYED }],
      }),
      sweep: async () => (calls++, { swept: 1 }),
      arriving: () => 25_432_350,
      creditArriving: async () => {
        calls++;
      },
      log: () => {},
    });
    expect(calls).toBe(0);
    expect(snap).toMatchObject({ spendable: 0, arriving: 25_432_350 });
  });

  test('nothing waiting: no sweep, no credit', async () => {
    let calls = 0;
    const snap = await prepareFunding({
      wallet: makeWallet({ funded: 5_000, deposits: [] }),
      sweep: async () => (calls++, { swept: 0 }),
      arriving: () => 0,
      creditArriving: async () => {
        calls++;
      },
      log: () => {},
    });
    expect(calls).toBe(0);
    expect(snap.spendable).toBe(5_000);
  });

  test('failed steps never throw', async () => {
    const snap = await prepareFunding({
      wallet: makeWallet({ funded: 0, deposits: [{ satoshis: 10, spendable: true, customInstructions: KEYED }] }),
      sweep: async () => {
        throw new Error('broadcast failed');
      },
      arriving: () => 5,
      creditArriving: async () => {
        throw new Error('indexer down');
      },
      log: () => {},
    });
    expect(snap).toMatchObject({ sweepable: 10, arriving: 5 });
  });
});

describe('insufficient funds message', () => {
  const snap = (s: Partial<FundingSnapshot>): FundingSnapshot => ({
    spendable: 0,
    sweepable: 0,
    held: 0,
    unsweepable: 0,
    arriving: 0,
    ...s,
  });
  test('recognises the toolbox error', () => {
    const e = new Error(VEXVOID_RAW);
    expect(isInsufficientFunds(e)).toBe(true);
    expect(isInsufficientFunds(new Error('user rejected'))).toBe(false);
  });
  test('names arriving money and keeps the Insufficient funds prefix', () => {
    const m = insufficientFundsMessage(new Error(VEXVOID_RAW), snap({ arriving: 25_432_350 }));
    expect(m.startsWith('Insufficient funds: this needs 670198 sats, and 0 sats are spendable')).toBe(true);
    expect(m).toContain('25432350 sats have arrived');
  });
  test('names unsweepable deposits', () => {
    expect(insufficientFundsMessage(new Error(VEXVOID_RAW), snap({ unsweepable: 7 }))).toContain(
      'support@bwalletx.com',
    );
  });
  test('plain shortfall asks to add funds', () => {
    expect(insufficientFundsMessage(new Error(VEXVOID_RAW), snap({ spendable: 10 }))).toContain('Add funds');
  });
});
