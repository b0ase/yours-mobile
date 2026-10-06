import { describe, expect, test } from 'bun:test';
import type { OneSatContext } from '@1sat/actions';
import { P2PKH } from '@bsv/sdk';
import {
  DEFAULT_FEE_PER_OUTPUT,
  INDEX_FUND_NETWORK_SATS,
  INDEX_FUND_SATS,
  fundAmount,
  holderIndexState,
  fundIndexing,
  indexCostSats,
  needsIndexFunding,
  indexFundDescription,
  overlayStatus,
  parseOverlayStatus,
  pickSentIndexFund,
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
    ).toEqual({ feeAddress: FEE, feePerOutput: 1000, isActive: true, balance: 1000, minFunding: 0 });
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
  test('amount: the mint funding (the indexer minimum), never below one output fee', () => {
    expect(fundAmount({ feePerOutput: 1000 })).toBe(INDEX_FUND_SATS);
    expect(fundAmount({ feePerOutput: 5000 }, 3000)).toBe(5000);
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
  test('broadcasts now: never left for the delayed-broadcast monitor', async () => {
    let args: { options?: { acceptDelayedBroadcast?: boolean } } = {};
    const ctx = {
      wallet: { createAction: async (a: typeof args) => ((args = a), { txid: 'f'.repeat(64) }) },
      services: { bsv21: { getTokenDetails: async () => details({ fee_address: FEE }) } },
    } as unknown as OneSatContext;
    await fundIndexing(ctx, ID, 'TESTY');
    expect(args.options?.acceptDelayedBroadcast).toBe(false);
  });
  test('a failed send that the wallet still holds as sent returns that txid (no double pay)', async () => {
    const tx = 'c'.repeat(64);
    const ctx = {
      wallet: {
        createAction: async () => {
          throw new Error('No broadcast verdict');
        },
        listActions: async () => ({
          totalActions: 1,
          actions: [{ txid: tx, status: 'sending', description: indexFundDescription('TESTY') }],
        }),
      },
      services: { bsv21: { getTokenDetails: async () => details({ fee_address: FEE }) } },
    } as unknown as OneSatContext;
    expect((await fundIndexing(ctx, ID, 'TESTY')).txid).toBe(tx);
  });
  test('a definite failure rethrows', async () => {
    const ctx = {
      wallet: {
        createAction: async () => {
          throw new Error('Insufficient funds');
        },
        listActions: async () => ({ totalActions: 0, actions: [] }),
      },
      services: { bsv21: { getTokenDetails: async () => details({ fee_address: FEE }) } },
    } as unknown as OneSatContext;
    await expect(fundIndexing(ctx, ID, 'TESTY')).rejects.toThrow(/Insufficient/);
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

test('pickSentIndexFund: newest matching (possibly) sent payment only', () => {
  const d = indexFundDescription('TESTY');
  const A = 'a'.repeat(64),
    B = 'b'.repeat(64);
  expect(pickSentIndexFund([{ txid: A, status: 'failed', description: d }], d)).toBeNull();
  expect(pickSentIndexFund([{ txid: A, status: 'sending', description: indexFundDescription('OTHER') }], d)).toBeNull();
  expect(
    pickSentIndexFund(
      [
        { txid: A, status: 'completed', description: d },
        { txid: B, status: 'unproven', description: d },
      ],
      d,
    ),
  ).toBe(B);
});

test('overlayStatus gives up on a hung indexer instead of waiting forever', async () => {
  const ctx = {
    services: { bsv21: { getTokenDetails: () => new Promise(() => {}) } },
  } as unknown as OneSatContext;
  const t0 = Date.now();
  expect(await overlayStatus(ctx, ID)).toBeNull();
  expect(Date.now() - t0).toBeLessThan(9000);
}, 12000);

test('withFavorite puts the new token first, deduped', () => {
  expect(withFavorite(undefined, `${'a'.repeat(64)}.0`)).toEqual([ID]);
  expect(withFavorite(['x', ID], ID)).toEqual([ID, 'x']);
});

describe('min_funding (indexer change, 2 Oct 2026)', () => {
  test('parsed when present, 0 when absent', () => {
    const FEE2 = '1MCFoVgirBpx8ogF6Cbkkr1nrFxgdEaPeZ';
    expect(parseOverlayStatus({ status: { fee_address: FEE2, min_funding: 10_000_000 } })?.minFunding).toBe(10_000_000);
    expect(parseOverlayStatus({ status: { fee_address: FEE2 } })?.minFunding).toBe(0);
  });
  test('the payment tops the balance up to the minimum ($TESTY: balance 2,000, minimum 10,000,000)', () => {
    expect(fundAmount({ feePerOutput: 1000, balance: 2000, minFunding: 10_000_000 })).toBe(9_998_000);
    expect(fundAmount({ feePerOutput: 1000, balance: -47_000, minFunding: 10_000_000 })).toBe(10_000_000);
    expect(fundAmount({ feePerOutput: 1000 })).toBe(INDEX_FUND_SATS);
    expect(fundAmount({ feePerOutput: 1000, balance: 0, minFunding: 10_000_000 })).toBe(INDEX_FUND_SATS);
  });
});

describe('holderIndexState', () => {
  const base = { feeAddress: '13B7JEP8p2DXAjCKaWWGuapmgqT3Fhc7gb', feePerOutput: 1000, minFunding: 10_000_000 };
  test('unknown when the indexer did not answer', () => {
    expect(holderIndexState(null)).toBe('unknown');
    expect(holderIndexState(undefined)).toBe('unknown');
  });
  test('indexed when active and funded (FROGGER-like, below min_funding but active)', () => {
    expect(holderIndexState({ ...base, isActive: true, balance: 9_966_980 })).toBe('indexed');
  });
  test('needs when inactive', () => {
    expect(holderIndexState({ ...base, isActive: false, balance: 0 })).toBe('needs');
  });
  test('needs when active but cannot pay one more output', () => {
    expect(holderIndexState({ ...base, isActive: true, balance: 999 })).toBe('needs');
  });
});
