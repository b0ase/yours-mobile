import { describe, expect, test } from 'bun:test';
import type { OneSatContext } from '@1sat/actions';
import { P2PKH } from '@bsv/sdk';
import {
  DEFAULT_FEE_PER_OUTPUT,
  INDEX_FUND_NETWORK_SATS,
  INDEX_FUND_SATS,
  fundAmount,
  fundIndexing,
  indexCostSats,
  needsIndexFunding,
  parseOverlayStatus,
  withFavorite,
} from './indexFund';

const ID = `${'a'.repeat(64)}_0`;
const FEE = '1HAeteL7Dk8vXQ3ctVyktyRqrAzgk4LwfU';
// Shape of GET api.1sat.app/1sat/bsv21/{id} (BURNTEST, phase-0 mainnet test).
const details = (status: Record<string, unknown>) => ({ tokenId: ID, token: { sym: 'X' }, status });

describe('overlay status', () => {
  test('parses the funding fields', () => {
    expect(
      parseOverlayStatus(details({ fee_address: FEE, fee_per_output: 1000, is_active: true, balance: 1000 })),
    ).toEqual({ feeAddress: FEE, feePerOutput: 1000, isActive: true, balance: 1000 });
  });
  test('unknown token / junk → null; missing fee rate → default', () => {
    expect(parseOverlayStatus(null)).toBeNull();
    expect(parseOverlayStatus({ message: 'token not found' })).toBeNull();
    expect(parseOverlayStatus(details({ fee_address: 'nope' }))).toBeNull();
    expect(parseOverlayStatus(details({ fee_address: FEE }))?.feePerOutput).toBe(DEFAULT_FEE_PER_OUTPUT);
  });
  test('needs funding until active with at least one output of balance', () => {
    const s = { feeAddress: FEE, feePerOutput: 1000, isActive: false, balance: 0 };
    expect(needsIndexFunding(null)).toBe(true);
    expect(needsIndexFunding(s)).toBe(true);
    expect(needsIndexFunding({ ...s, isActive: true, balance: 999 })).toBe(true);
    expect(needsIndexFunding({ ...s, isActive: true, balance: 1000 })).toBe(false);
  });
  test('amount: the pre-fund, never below one output fee', () => {
    expect(fundAmount({ feePerOutput: 1000 })).toBe(INDEX_FUND_SATS);
    expect(fundAmount({ feePerOutput: 5000 })).toBe(5000);
    expect(indexCostSats()).toBe(INDEX_FUND_SATS + INDEX_FUND_NETWORK_SATS);
  });
});

describe('fundIndexing', () => {
  test('pays the fee address via createAction (P2PKH, labelled) and returns the txid', async () => {
    const calls: unknown[] = [];
    const ctx = {
      wallet: {
        createAction: async (args: unknown) => {
          calls.push(args);
          return { txid: 'f'.repeat(64) };
        },
      },
      services: {
        bsv21: {
          getTokenDetails: async () => details({ fee_address: FEE, fee_per_output: 1000, is_active: false }),
        },
      },
    } as unknown as OneSatContext;
    const r = await fundIndexing(ctx, ID, 'TESTY');
    expect(r).toMatchObject({ txid: 'f'.repeat(64), sats: INDEX_FUND_SATS, feeAddress: FEE });
    const a = calls[0] as { outputs: { lockingScript: string; satoshis: number }[]; labels: string[] };
    expect(a.outputs).toHaveLength(1);
    expect(a.outputs[0].satoshis).toBe(INDEX_FUND_SATS);
    expect(a.outputs[0].lockingScript).toBe(new P2PKH().lock(FEE).toHex());
    expect(a.labels).toContain('bsv21-index-fund');
  });
  test('refuses (sends nothing) while the indexer has not seen the token', async () => {
    let sent = false;
    const ctx = {
      wallet: { createAction: async () => ((sent = true), { txid: 'x' }) },
      services: { bsv21: { getTokenDetails: async () => ({ message: 'token not found' }) } },
    } as unknown as OneSatContext;
    await expect(fundIndexing(ctx, ID, 'TESTY', { timeoutMs: 0 })).rejects.toThrow(/hasn't seen/);
    expect(sent).toBe(false);
  });
});

test('withFavorite puts the new token first, deduped', () => {
  expect(withFavorite(undefined, `${'a'.repeat(64)}.0`)).toEqual([ID]);
  expect(withFavorite(['x', ID], ID)).toEqual([ID, 'x']);
});
