import { describe, expect, test } from 'bun:test';
import { PrivateKey } from '@bsv/sdk';
import { Sealer, deriveSession, newChannel } from './protocol';
import { inOrder } from './in-order';

describe('inOrder', () => {
  test('runs frames one at a time, in arrival order', async () => {
    const seen: number[] = [];
    const h = inOrder(async (n: number) => {
      await new Promise((r) => setTimeout(r, n === 1 ? 20 : 0));
      seen.push(n);
    });
    h(1);
    h(2);
    h(3);
    await new Promise((r) => setTimeout(r, 60));
    expect(seen).toEqual([1, 2, 3]);
  });

  test('two sealed frames back to back: both open, in order, and lastSeen ends at the higher one', async () => {
    const c = newChannel();
    const S = PrivateKey.fromRandom();
    const P = PrivateKey.fromRandom();
    const site = new Sealer((await deriveSession(S, P.toPublicKey().toString(), c)).key, 'site');
    const wallet = new Sealer((await deriveSession(P, S.toPublicKey().toString(), c)).key, 'wallet');
    const f1 = await site.seal({ t: 'req', id: '1', action: 'a', params: {} });
    const f2 = await site.seal({ t: 'req', id: '2', action: 'b', params: {} });
    const got: string[] = [];
    const h = inOrder(async (f: typeof f1) => {
      const m = await wallet.open(f);
      if (m?.t === 'req') got.push(m.id);
    });
    h(f1);
    h(f2);
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toEqual(['1', '2']);
    expect(wallet.counters.lastSeen).toBe(2);
    expect(await wallet.open(f2)).toBeNull(); // replay still refused
  });

  test('a throwing frame does not stop the next one', async () => {
    const seen: number[] = [];
    const h = inOrder(async (n: number) => {
      if (n === 1) throw new Error('bad frame');
      seen.push(n);
    });
    h(1);
    h(2);
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([2]);
  });
});
