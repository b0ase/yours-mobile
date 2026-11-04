import { describe, expect, test } from 'bun:test';
import { createRateLimiter, installWocLimiter, isWocRequest } from './wocLimiter';

/** A manual clock: timers fire when the clock is advanced past them. */
function clock() {
  let t = 0;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => void timers.push({ at: t + ms, fn }),
    advance: async (ms: number) => {
      t += ms;
      const due = timers.filter((x) => x.at <= t);
      timers.splice(0, timers.length, ...timers.filter((x) => x.at > t));
      for (const x of due) x.fn();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

describe('createRateLimiter', () => {
  test('at most 3 slots in any second, first come first served', async () => {
    const c = clock();
    const l = createRateLimiter({ max: 3, windowMs: 1000, now: c.now, setTimer: c.setTimer });
    const got: number[] = [];
    for (let i = 0; i < 7; i++) void l.slot().then(() => got.push(i));
    await c.advance(0);
    expect(got).toEqual([0, 1, 2]);
    await c.advance(999);
    expect(got).toEqual([0, 1, 2]);
    await c.advance(1);
    expect(got).toEqual([0, 1, 2, 3, 4, 5]);
    await c.advance(1000);
    expect(got).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(l.waiting()).toBe(0);
  });
});

describe('installWocLimiter', () => {
  test('only WhatsOnChain requests wait for a slot; other hosts and the arguments pass through', async () => {
    const calls: string[] = [];
    const scope = {
      fetch: (async (u: string) => (calls.push(String(u)), new Response('ok'))) as unknown as typeof fetch,
    };
    let slots = 0;
    expect(installWocLimiter(scope, { slot: async () => void slots++, waiting: () => 0 })).toBe(true);
    await scope.fetch('https://api.whatsonchain.com/v1/bsv/main/tx/aa/0/spent');
    await scope.fetch('https://api.1sat.app/1sat/txo/spends');
    expect(slots).toBe(1);
    expect(calls).toEqual([
      'https://api.whatsonchain.com/v1/bsv/main/tx/aa/0/spent',
      'https://api.1sat.app/1sat/txo/spends',
    ]);
    // Idempotent: a second install doesn't wrap twice.
    expect(installWocLimiter(scope)).toBe(true);
    await scope.fetch('https://api.whatsonchain.com/v1/bsv/main/chain/info');
    expect(slots).toBe(2);
    expect(installWocLimiter({})).toBe(false);
  });
  test('recognises a WhatsOnChain request given as a string, URL or Request', () => {
    expect(isWocRequest('https://api.whatsonchain.com/v1/bsv/main/tx/hash/aa')).toBe(true);
    expect(isWocRequest(new URL('https://api.whatsonchain.com/v1/bsv/main/chain/info'))).toBe(true);
    expect(isWocRequest(new Request('https://api.whatsonchain.com/v1/bsv/main/chain/info'))).toBe(true);
    expect(isWocRequest('https://whatsonchain.com/tx/aa')).toBe(false);
    expect(isWocRequest(undefined)).toBe(false);
  });
});
