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

const ORIGIN = `${'a'.repeat(64)}.2`;

type Names = {
  /** What ORDFS says the listed coin's inscription is (null = ORDFS can't answer). */
  held?: { origin: string; contentType: string } | null;
  /** The inscription content at each origin. */
  content?: Record<string, string>;
  /** The 1sat name index's registered origin for each name (missing = not registered / unreachable). */
  registered?: Record<string, string>;
};

/**
 * A context whose services return a listing tx paying `payoutSats` at vout 0. By default the listed coin is the
 * genuine OpNS name "alice" (origin ORIGIN, content "alice", registered at ORIGIN).
 */
const ctxFor = (payoutSats: number, n: Names = {}) => {
  const tx = new Transaction();
  tx.addOutput({ lockingScript: new LockingScript(OrdLockV2.lock(ADDR, ADDR, payoutSats).chunks), satoshis: 1 });
  const beef = new Beef();
  beef.mergeTransaction(tx);
  const txid = tx.id('hex');
  const held = n.held === undefined ? { origin: ORIGIN, contentType: 'application/op-ns' } : n.held;
  const content = n.content ?? { [ORIGIN]: 'alice' };
  const registered = n.registered ?? { alice: ORIGIN };
  const ordfsCalls: string[] = [];
  const ctx = {
    wallet: {},
    services: {
      getBeefForTxid: async () => beef,
      ordfs: {
        getMetadata: async (outpoint: string, seq?: number) => {
          ordfsCalls.push(`${outpoint}:${seq}`);
          if (!held) throw new Error('ordfs down');
          return { outpoint, sequence: 1, contentLength: 5, ...held };
        },
        getContent: async (origin: string) => {
          const text = content[origin] ?? content[origin.replace('_', '.')];
          if (text === undefined) throw new Error('no content');
          return { data: new TextEncoder().encode(text), headers: { contentType: 'application/op-ns' } };
        },
      },
      opns: {
        getOrigin: async (name: string) => {
          if (!registered[name]) throw new Error('Name not registered');
          return { name, outpoint: registered[name] };
        },
      },
    },
  } as never;
  return { ctx, outpoint: `${txid}_0`, ordfsCalls };
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

  // b-Aware row 349: the sheet's name came from the listing's metadata; the coin bought must be that very name.
  test('refuses a listing whose inscription is a different name than the one approved', async () => {
    const { ctx, outpoint } = ctxFor(1_000, {
      content: { [ORIGIN]: 'bob' },
      registered: { alice: ORIGIN, bob: ORIGIN },
    });
    await expect(buy(ctx, outpoint, 'alice', 1_000)).rejects.toThrow(/isn't the name/);
    expect(calls.length).toBe(0);
  });

  test('refuses a counterfeit: an op-ns inscription reading "alice" that is not the registered alice', async () => {
    const FAKE = `${'f'.repeat(64)}.0`;
    const { ctx, outpoint } = ctxFor(1_000, {
      held: { origin: FAKE, contentType: 'application/op-ns' },
      content: { [FAKE]: 'alice' },
    });
    await expect(buy(ctx, outpoint, 'alice', 1_000)).rejects.toThrow(/isn't the name/);
    expect(calls.length).toBe(0);
  });

  test('refuses a listing that is not an OpNS name at all', async () => {
    const { ctx, outpoint } = ctxFor(1_000, { held: { origin: ORIGIN, contentType: 'image/png' } });
    await expect(buy(ctx, outpoint, 'alice', 1_000)).rejects.toThrow(/isn't the name/);
    expect(calls.length).toBe(0);
  });

  test("refuses when the name can't be checked (ORDFS or the name index down)", async () => {
    const a = ctxFor(1_000, { held: null });
    await expect(buy(a.ctx, a.outpoint, 'alice', 1_000)).rejects.toThrow(/Couldn't check/);
    const b = ctxFor(1_000, { registered: {} });
    await expect(buy(b.ctx, b.outpoint, 'alice', 1_000)).rejects.toThrow(/Couldn't check/);
    expect(calls.length).toBe(0);
  });

  test('the genuine name buys, carrying its checked origin', async () => {
    const { ctx, outpoint } = ctxFor(1_000);
    await expect(buy(ctx, outpoint, 'Alice', 1_000)).resolves.toBe('f'.repeat(64));
    expect(calls[0].origin).toBe(ORIGIN);
  });
});
