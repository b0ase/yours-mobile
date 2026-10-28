import { describe, expect, mock, test } from 'bun:test';

const KEY = '02' + 'ab'.repeat(32);
mock.module('./potSend', () => ({
  broadcastPnee: async () => '',
  broadcastRaw: async () => '',
  potBalanceSats: async () => 0,
  potPneeUnits: async () => 0,
  signFromPot: async () => ({ rawTx: '', txid: '' }),
  signPneeFromPot: async () => ({ rawTx: '', txid: '' }),
  payeeAddress: async () => '1Payee',
  resolvePayee: async () => ({ address: '1Payee', pubkey: KEY }),
}));

/**
 * b-Aware 25 Oct 2026 (mahetagaurang22; dup 28 Oct hilmiadi677 H-4): the scheduler resolved payees to a bare
 * address, so payDue never saw a key, never pinned one, and a changed payee key was never caught.
 */
describe('subscription scheduler resolves payees with their key', () => {
  test('engineResolve hands payDue the payee key, not just an address', async () => {
    const engine = (await import('./potsEngine')) as Record<string, unknown>;
    const resolve = engine.engineResolve as ((p: unknown) => Promise<unknown>) | undefined;
    expect(typeof resolve).toBe('function');
    const d = await resolve!({ name: 'Alice', paymail: 'alice@bwalletx.com' });
    expect(d).toEqual({ address: '1Payee', pubkey: KEY });
  });
});
