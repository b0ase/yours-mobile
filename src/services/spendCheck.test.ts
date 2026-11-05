import { describe, expect, test } from 'bun:test';
import { makeSpendCheck, wocSpendLookup } from './spendCheck';

const T = (n: number) => n.toString(16).padStart(64, '0');
const S = 'ab'.repeat(32);

describe('spend check (review 20 re-check)', () => {
  test('N1: a WhatsOnChain answer that never comes is given up on; the index answer stands', async () => {
    const check = makeSpendCheck({
      index: async (b) => b.map(() => null),
      woc: () => new Promise<string | null>(() => undefined), // hangs
      wocTimeoutMs: 50,
    });
    const t0 = Date.now();
    const r = await check([`${T(1)}.0`]);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(r.get(`${T(1)}.0`)).toBeNull();
  });

  test('N1: the WhatsOnChain lookup aborts its request after the timeout', async () => {
    let signal: AbortSignal | undefined;
    const lookup = wocSpendLookup(50, (async (_u: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_, no) => signal?.addEventListener('abort', () => no(new Error('aborted'))));
    }) as typeof fetch);
    await expect(lookup(`${T(2)}_0`)).rejects.toThrow();
    expect(signal?.aborted).toBe(true);
    const spent = wocSpendLookup(
      1_000,
      (async () => new Response(JSON.stringify({ txid: S, status: 'unconfirmed' }))) as unknown as typeof fetch,
    );
    expect(await spent(`${T(3)}_1`)).toBe(S);
    const unspent = wocSpendLookup(1_000, (async () => new Response('', { status: 404 })) as unknown as typeof fetch);
    expect(await unspent(`${T(3)}_1`)).toBeNull();
  });

  test('N5: the index reply for an unspent output is null (checked live, 5 Nov 2026); anything else is "can’t tell"', async () => {
    const check = makeSpendCheck({ index: async (b) => b.map((_, i) => (i === 0 ? null : i === 1 ? '' : S)) });
    const r = await check([`${T(1)}.0`, `${T(2)}.0`, `${T(3)}.0`]);
    expect(r.get(`${T(1)}.0`)).toBeNull();
    expect(r.has(`${T(2)}.0`)).toBe(false);
    expect(r.get(`${T(3)}.0`)).toBe(S);
  });

  test('N3: answers primed in one batched call are reused for a while, so a restore asks once per 100 coins', async () => {
    let calls = 0;
    let clock = 0;
    const check = makeSpendCheck({
      index: async (b) => (calls++, b.map(() => null)),
      cacheMs: 60_000,
      now: () => clock,
    });
    const ops = Array.from({ length: 150 }, (_, i) => `${T(i + 1)}.0`);
    await check(ops);
    expect(calls).toBe(2);
    for (const o of ops) await check([o]);
    expect(calls).toBe(2);
    clock += 60_001;
    await check([ops[0]]);
    expect(calls).toBe(3);
  });
});
