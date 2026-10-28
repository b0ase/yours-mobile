import { describe, expect, test } from 'bun:test';
import type { OneSatContext } from '@1sat/actions';
import { releaseExpired, releaseSwap, type ReservationStore, type SwapReservation } from './swapActions';

const res = (ref: string, expiresAt: number): SwapReservation => ({
  ref,
  outpoint: `${'ab'.repeat(32)}.1`,
  tokenId: `${'cd'.repeat(32)}_0`,
  beef: '0100',
  ci: '{"protocolID":[1,"x"],"keyID":"k"}',
  expiresAt,
  at: 0,
});
const memStore = (rs: SwapReservation[]): ReservationStore & { m: Map<string, SwapReservation> } => {
  const m = new Map(rs.map((r) => [r.ref, r]));
  return {
    m,
    list: async () => [...m.values()],
    put: async (r) => void m.set(r.ref, r),
    drop: async (ref) => void m.delete(ref),
  };
};
const ctxWith = (internalize: (a: unknown) => Promise<unknown>) =>
  ({ wallet: { internalizeAction: internalize } }) as unknown as OneSatContext;

describe('offer reservations (reject / counter / expiry void the held token output)', () => {
  test('release puts the output back in the token basket and forgets it', async () => {
    const store = memStore([res('r1', 9e15)]);
    const calls: unknown[] = [];
    const ok = await releaseSwap(
      ctxWith(async (a) => calls.push(a)),
      store,
      'r1',
    );
    expect(ok).toBe(true);
    expect(store.m.size).toBe(0);
    const a = calls[0] as {
      outputs: { outputIndex: number; protocol: string; insertionRemittance: { basket: string } }[];
    };
    expect(a.outputs[0]).toMatchObject({ outputIndex: 1, protocol: 'basket insertion' });
    expect(a.outputs[0].insertionRemittance.basket).toBeTruthy();
  });

  test('already spent (the buyer completed) just ends the reservation', async () => {
    const store = memStore([res('r1', 9e15)]);
    await releaseSwap(
      ctxWith(async () => Promise.reject(new Error('output already spent'))),
      store,
      'r1',
    );
    expect(store.m.size).toBe(0);
  });

  test('any other failure keeps the reservation so it can be retried', async () => {
    const store = memStore([res('r1', 9e15)]);
    await expect(
      releaseSwap(
        ctxWith(async () => Promise.reject(new Error('offline'))),
        store,
        'r1',
      ),
    ).rejects.toThrow();
    expect(store.m.size).toBe(1);
  });

  test('unknown ref releases nothing', async () => {
    expect(
      await releaseSwap(
        ctxWith(async () => undefined),
        memStore([]),
        'nope',
      ),
    ).toBe(false);
  });

  test('expired reservations are released, live ones kept', async () => {
    const store = memStore([res('old', 100), res('live', 10_000)]);
    await releaseExpired(
      ctxWith(async () => undefined),
      store,
      5_000,
    );
    expect([...store.m.keys()]).toEqual(['live']);
  });
});
