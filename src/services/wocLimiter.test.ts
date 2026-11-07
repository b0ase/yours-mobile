import { describe, expect, test } from 'bun:test';
import {
  createLockPacer,
  createRateLimiter,
  installWocLimiter,
  isWocRequest,
  WOC_LOCK,
  WOC_PAUSE_MS,
  type LocksLike,
  type Pacer,
} from './wocLimiter';
import { deadline } from '../utils/abortTimeout';

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
  test('17c L2: a priority request (the coin check before a send) goes ahead of waiting ones', async () => {
    const c = clock();
    const l = createRateLimiter({ max: 1, windowMs: 1000, now: c.now, setTimer: c.setTimer });
    const got: string[] = [];
    await l.slot();
    void l.slot().then(() => got.push('walk 1'));
    void l.slot().then(() => got.push('walk 2'));
    void l.slot(undefined, true).then(() => got.push('send check'));
    await c.advance(1000);
    expect(got).toEqual(['send check']);
    await c.advance(1000);
    expect(got).toEqual(['send check', 'walk 1']);
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
    expect(next).toBe(true);
    const pre = new AbortController();
    pre.abort();
    expect(await l.slot(pre.signal).catch((e: Error) => e.name)).toBe('AbortError');
  });
  test('17c L1: a 429 pause is a fixed backoff, and pauses never stack', async () => {
    const c = clock();
    const l = createRateLimiter({ max: 3, windowMs: 1000, pauseMs: 2_000, now: c.now, setTimer: c.setTimer });
    l.pause();
    await c.advance(1_500);
    l.pause(); // a second 429 while paused: not extended
    let got = false;
    void l.slot().then(() => (got = true));
    await c.advance(499);
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

/** Web Locks stand-in: one FIFO lock per name. */
function fakeLocks() {
  type Entry = { cb: () => Promise<void>; done: (v: unknown) => void; fail: (e: unknown) => void };
  const queues = new Map<string, Entry[]>();
  const held = new Set<string>();
  let requests = 0;
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
    request: (name, _options, cb) =>
      new Promise((done, fail) => {
        requests++;
        const q = queues.get(name) ?? [];
        q.push({ cb, done, fail });
        queues.set(name, q);
        run(name);
      }),
  };
  return { locks, names: () => [...queues.keys()], requests: () => requests };
}

describe('createLockPacer (app-wide: every context of the origin shares one lock)', () => {
  test('one start per gap; this context asks for the lock one at a time; priority first; abort leaves', async () => {
    const { locks, names, requests } = fakeLocks();
    const gaps: (() => void)[] = [];
    const pacer = createLockPacer(locks, { gapMs: 334, sleep: () => new Promise<void>((r) => gaps.push(r)) });
    const got: string[] = [];
    void pacer.slot().then(() => got.push('a'));
    const ac = new AbortController();
    const b = pacer.slot(ac.signal).catch((e: Error) => e.name);
    void pacer.slot().then(() => got.push('c'));
    void pacer.slot(undefined, true).then(() => got.push('send check'));
    await tick();
    expect(got).toEqual(['a']);
    expect(requests()).toBe(1); // one lock request outstanding per context
    ac.abort();
    expect(await b).toBe('AbortError');
    gaps.shift()!();
    await tick();
    expect(got).toEqual(['a', 'send check']);
    gaps.shift()!();
    await tick();
    expect(got).toEqual(['a', 'send check', 'c']);
    expect(names()).toEqual([WOC_LOCK]);
  });
  test('17c L1: a pause holds the shared lock once; a second one while it runs is not stacked', async () => {
    const { locks, requests } = fakeLocks();
    const asked: number[] = [];
    let release!: () => void;
    const pacer = createLockPacer(locks, {
      sleep: (ms) => (asked.push(ms), new Promise<void>((r) => (release = r))),
    });
    pacer.pause();
    pacer.pause();
    await tick();
    expect(asked).toEqual([WOC_PAUSE_MS]);
    expect(requests()).toBe(1);
    release();
  });
});

describe('installWocLimiter', () => {
  const pacerSpy = () => {
    const slots: { signal?: AbortSignal; priority?: boolean }[] = [];
    let pauses = 0;
    const pacer: Pacer = {
      slot: async (signal, priority) => void slots.push({ signal, priority }),
      pause: () => void pauses++,
    };
    return { pacer, slots, pauses: () => pauses };
  };
  test('only WhatsOnChain requests wait; the signal and priority reach the pacer; a 429 pauses', async () => {
    const calls: string[] = [];
    const scope = {
      fetch: (async (u: string) => {
        calls.push(String(u));
        return String(u).endsWith('/busy') ? new Response('', { status: 429 }) : new Response('ok');
      }) as unknown as typeof fetch,
    };
    const spy = pacerSpy();
    expect(installWocLimiter(scope, { pacer: spy.pacer })).toBe(true);
    const ac = new AbortController();
    await scope.fetch('https://api.whatsonchain.com/v1/bsv/main/tx/aa/0/spent', {
      signal: ac.signal,
      priority: 'high',
    } as RequestInit);
    await scope.fetch('https://api.1sat.app/1sat/txo/spends');
    await scope.fetch('https://api.whatsonchain.com/v1/bsv/main/busy');
    expect(spy.slots).toEqual([
      { signal: ac.signal, priority: true },
      { signal: undefined, priority: false },
    ]);
    expect(spy.pauses()).toBe(1);
    expect(calls).toHaveLength(3);
    expect(installWocLimiter(scope)).toBe(true); // idempotent
    expect(installWocLimiter({})).toBe(false);
  });
  test('17c L1: a 429 hidden by CORS (a thrown network error) pauses too; our own abort does not', async () => {
    let mode: 'cors' | 'abort' = 'cors';
    const scope = {
      fetch: (async () => {
        if (mode === 'cors') throw new TypeError('Failed to fetch');
        throw new DOMException('Aborted', 'AbortError');
      }) as unknown as typeof fetch,
    };
    const spy = pacerSpy();
    installWocLimiter(scope, { pacer: spy.pacer });
    await scope.fetch('https://api.whatsonchain.com/v1/bsv/main/x').catch(() => undefined);
    expect(spy.pauses()).toBe(1);
    mode = 'abort';
    await scope.fetch('https://api.whatsonchain.com/v1/bsv/main/x').catch(() => undefined);
    expect(spy.pauses()).toBe(1);
  });
  test('17d L2 (reviewer W1): a request that times out (deadline TimeoutError) does not pause everyone else', async () => {
    const scope = {
      fetch: ((_u: string, i?: RequestInit) =>
        new Promise((_, rej) => i?.signal?.addEventListener('abort', () => rej(i.signal!.reason)))) as never,
    } as { fetch: typeof fetch };
    const spy = pacerSpy();
    installWocLimiter(scope, { pacer: spy.pacer });
    const d = deadline(20);
    const name = await scope
      .fetch('https://api.whatsonchain.com/v1/bsv/main/tx/hash/00', { signal: d.signal })
      .catch((e: { name?: string }) => e?.name);
    expect(name).toBe('TimeoutError');
    expect(spy.pauses()).toBe(0); // before the fix: 1 (a 2 s app-wide pause per slow request)
  });
  test('recognises a WhatsOnChain request given as a string, URL or Request', () => {
    expect(isWocRequest('https://api.whatsonchain.com/v1/bsv/main/tx/hash/aa')).toBe(true);
    expect(isWocRequest(new URL('https://api.whatsonchain.com/v1/bsv/main/chain/info'))).toBe(true);
    expect(isWocRequest(new Request('https://api.whatsonchain.com/v1/bsv/main/chain/info'))).toBe(true);
    expect(isWocRequest('https://whatsonchain.com/tx/aa')).toBe(false);
    expect(isWocRequest(undefined)).toBe(false);
  });
});
