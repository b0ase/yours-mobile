import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Beef, LockingScript, Transaction } from '@bsv/sdk';
import { OrdLockV2 } from '@1sat/templates';

const calls: Array<Record<string, unknown>> = [];
// bun module mocks are process-wide: keep every real export, and hand these back to the real ones once this file is
// done, so later files that import @1sat/actions or ordlockVersion get the real code.
const realActions = { ...(await import('@1sat/actions')) };
const realOrdlock = { ...(await import('../market/ordlockVersion')) };
let active = true;
afterAll(() => {
  active = false;
});
type Exec = { execute: (...a: never[]) => unknown };
const fake = (name: keyof typeof realActions, f: (...a: never[]) => unknown): Exec => ({
  execute: (...a: never[]) => (active ? f(...a) : (realActions[name] as unknown as Exec).execute(...a)),
});
mock.module('@1sat/actions', () => ({
  ...realActions,
  buyOrdinal: fake('buyOrdinal', async (_ctx: unknown, input: Record<string, unknown>) => {
    calls.push(input);
    return { txid: 'f'.repeat(64) };
  }),
  cancelOpnsListing: fake('cancelOpnsListing', async () => ({})),
  listOpns: fake('listOpns', async () => ({ outputs: [] })),
  sellOpns: fake('sellOpns', async () => ({})),
  sendOpns: fake('sendOpns', async () => ({})),
}));
mock.module('../market/ordlockVersion', () => ({
  ...realOrdlock,
  assertOrdLockV2: (...a: Parameters<typeof realOrdlock.assertOrdLockV2>) =>
    active ? Promise.resolve(undefined) : realOrdlock.assertOrdLockV2(...a),
}));

const { buyOpnsListing } = await import('./opnsBuy');

const ADDR = '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH';

/** A context whose services return a listing tx paying `payoutSats` at vout 0. */
const ctxFor = (payoutSats: number) => {
  const tx = new Transaction();
  tx.addOutput({ lockingScript: new LockingScript(OrdLockV2.lock(ADDR, ADDR, payoutSats).chunks), satoshis: 1 });
  const beef = new Beef();
  beef.mergeTransaction(tx);
  const txid = tx.id('hex');
  const ctx = { wallet: {}, services: { getBeefForTxid: async () => beef } } as never;
  return { ctx, outpoint: `${txid}_0` };
};

const buy = buyOpnsListing as unknown as (ctx: never, op: string, name: string, sats: number) => Promise<string>;

describe('buyOpnsListing', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  test('refuses when the covenant payout is higher than the approved (MAP) price', async () => {
    const { ctx, outpoint } = ctxFor(5_000_000);
    await expect(buy(ctx, outpoint, 'alice', 1_000)).rejects.toThrow();
    expect(calls.length).toBe(0);
  });

  test('refuses when no approved price is given', async () => {
    const { ctx, outpoint } = ctxFor(1_000);
    await expect(
      (buyOpnsListing as unknown as (...a: unknown[]) => Promise<string>)(ctx, outpoint, 'alice'),
    ).rejects.toThrow();
    expect(calls.length).toBe(0);
  });

  test('a matching listing goes through and buys the checked BEEF with no marketplace fee', async () => {
    const { ctx, outpoint } = ctxFor(1_000);
    await expect(buy(ctx, outpoint, 'alice', 1_000)).resolves.toBe('f'.repeat(64));
    expect(calls.length).toBe(1);
    expect(calls[0].inputBEEF).toBeDefined();
    expect(calls[0].marketplaceAddress).toBeUndefined();
  });
});
