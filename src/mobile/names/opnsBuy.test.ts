import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Beef, LockingScript, Transaction } from '@bsv/sdk';
import { OrdLockV2 } from '@1sat/templates';

const calls: Array<Record<string, unknown>> = [];
mock.module('@1sat/actions', () => ({
  buyOrdinal: {
    execute: async (_ctx: unknown, input: Record<string, unknown>) => {
      calls.push(input);
      return { txid: 'f'.repeat(64) };
    },
  },
  cancelOpnsListing: { execute: async () => ({}) },
  listOpns: { execute: async () => ({ outputs: [] }) },
  sellOpns: { execute: async () => ({}) },
  sendOpns: { execute: async () => ({}) },
}));
mock.module('../market/ordlockVersion', () => ({ assertOrdLockV2: async () => undefined }));

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
