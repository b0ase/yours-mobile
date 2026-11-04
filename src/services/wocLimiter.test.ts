import { describe, expect, test } from 'bun:test';
import {
  createLockPacer,
  createRateLimiter,
  installWocLimiter,
  isWocRequest,
  retryAfterMs,
  WOC_LOCK,
  WOC_PAUSE_MAX_MS,
  type LocksLike,
  type Pacer,
} from './wocLimiter';

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
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createRateLimiter (the fallback without Web Locks)', () => {
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
  test('17b L2: a request aborted while queued gives its place up and never takes a slot', async () => {
    const c = clock();
    const l = createRateLimiter({ max: 1, windowMs: 1000, now: c.now, setTimer: c.setTimer });
    await l.slot();
    const ac = new AbortController();
    const aborted = l.slot(ac.signal).then(
      () => 'slot',
      (e: Error) => e.name,
    );
    let next = false;
    void l.slot().then(() => (next = true));
    ac.abort();
    expect(await aborted).toBe('AbortError');
    expect(l.waiting()).toBe(1);
    await c.advance(1000);
    expect(next).toBe(true); // the abandoned request's slot went to the next one
    // Already aborted: refused at once, nothing queued.
    const pre = new AbortController();
    pre.abort();
    expect(await l.slot(pre.signal).catch((e: Error) => e.name)).toBe('AbortError');
  });
  test('17b L2: a 429 pause holds every request back for its length', async () => {
    const c = clock();
    const l = createRateLimiter({ max: 3, windowMs: 1000, now: c.now, setTimer: c.setTimer });
    l.pause(5_000);
    let got = false;
    void l.slot().then(() => (got = true));
    await c.advance(4_999);
    expect(got).toBe(false);
    await c.advance(1);
    expect(got).toBe(true);
  });
  test('17b L2: a monotonic clock: the wall clock going back an hour does not stall requests', async () => {
    const realNow = Date.now;
    try {
      const l = createRateLimiter({ max: 3, windowMs: 1000 });
      for (let i = 0; i < 3; i++) await l.slot();
      Date.now = () => realNow() - 3_600_000;
      const t0 = performance.now();
      await l.slot();
      expect(performance.now() - t0).toBeLessThan(1_500);
    } finally {
      Date.now = realNow;
    }
  });
});

/** Web Locks stand-in: one FIFO lock per name, `signal` leaves the queue. */
function fakeLocks() {
  type Entry = { cb: () => Promise<void>; done: (v: unknown) => void; fail: (e: unknown) => void };
  const queues = new Map<string, Entry[]>();
  const held = new Set<string>();
  const run = (name: string) => {
    if (held.has(name)) return;
    const next = (queues.get(name) ?? []).shift();
    if (!next) return;
    held.add(name);
    next
      .cb()
      .then(next.done, next.fail)
      .finally(() => {
        held.delete(name);
        run(name);
      });
  };
  const locks: LocksLike = {
    request: (name, options, cb) =>
      new Promise((done, fail) => {
        const q = queues.get(name) ?? [];
        const entry: Entry = { cb, done, fail };
        q.push(entry);
        queues.set(name, q);
        options.signal?.addEventListener('abort', () => {
          const i = q.indexOf(entry);
          if (i >= 0) {
            q.splice(i, 1);
            fail(new DOMException('Aborted', 'AbortError'));
          }
        });
        run(name);
      }),
  };
  return { locks, names: () => [...queues.keys()] };
}

describe('createLockPacer (app-wide: every context of the origin shares one lock)', () => {
  test('one request start per gap across all callers, in order; an abort leaves the queue', async () => {
    const { locks, names } = fakeLocks();
    const sleeps: (() => void)[] = [];
    const pacer = createLockPacer(locks, { gapMs: 334, sleep: () => new Promise<void>((r) => sleeps.push(r)) });
    const got: number[] = [];
    void pacer.slot().then(() => got.push(1));
    const ac = new AbortController();
    const second = pacer.slot(ac.signal).catch((e: Error) => e.name);
    void pacer.slot().then(() => got.push(3));
    await tick();
    expect(got).toEqual([1]); // the first holds the lock for its gap
    ac.abort();
    expect(await second).toBe('AbortError');
    sleeps.shift()!(); // the gap ends
    await tick();
    expect(got).toEqual([1, 3]);
    expect(names()).toEqual([WOC_LOCK]);
  });
  test('a pause holds the shared lock, capped', async () => {
    const { locks } = fakeLocks();
    const asked: number[] = [];
    const pacer = createLockPacer(locks, { sleep: async (ms) => void asked.push(ms) });
    pacer.pause(60_000);
    await tick();
    expect(asked).toEqual([WOC_PAUSE_MAX_MS]);
  });
});

describe('retryAfterMs', () => {
  const r = (v: string | null) => ({ headers: { get: () => v } });
  test('seconds, a date, the default, and the cap', () => {
    expect(retryAfterMs(r('5'))).toBe(5_000);
    expect(retryAfterMs(r(new Date(10_000).toUTCString()), 4_000)).toBe(6_000);
    expect(retryAfterMs(r(null))).toBe(2_000);
    expect(retryAfterMs(r('3600'))).toBe(WOC_PAUSE_MAX_MS);
  });
});

describe('installWocLimiter', () => {
  test('only WhatsOnChain requests wait; a 429 pauses for Retry-After; the signal reaches the pacer', async () => {
    const calls: string[] = [];
    const scope = {
      fetch: (async (u: string) => {
        calls.push(String(u));
        return String(u).endsWith('/busy')
          ? new Response('', { status: 429, headers: { 'retry-after': '7' } })
          : new Response('ok');
      }) as unknown as typeof fetch,
    };
    const slots: (AbortSignal | undefined)[] = [];
    const paused: number[] = [];
    const pacer: Pacer = { slot: async (s) => void slots.push(s), pause: (ms) => void paused.push(ms) };
    expect(installWocLimiter(scope, { pacer })).toBe(true);
    const ac = new AbortController();
    await scope.fetch('https://api.whatsonchain.com/v1/bsv/main/tx/aa/0/spent', { signal: ac.signal });
    await scope.fetch('https://api.1sat.app/1sat/txo/spends');
    await scope.fetch('https://api.whatsonchain.com/v1/bsv/main/busy');
    expect(slots).toEqual([ac.signal, undefined]);
    expect(paused).toEqual([7_000]);
    expect(calls).toHaveLength(3);
    // Idempotent: a second install doesn't wrap twice.
    expect(installWocLimiter(scope)).toBe(true);
    await scope.fetch('https://api.whatsonchain.com/v1/bsv/main/chain/info');
    expect(slots).toHaveLength(3);
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
