/**
 * Hub storage.local writes (re-review A of fix/web-one-tab, 13 Nov 2026). The writes are queued so they reach the
 * backend in order, but a refused write (the one-tab fence could not confirm ownership, a full localStorage) used to
 * leave the queue rejected, so every later write failed until a reload. The reviewer's probe, as a repo test.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hub } from './hub';

describe('hub: one refused write never breaks the next', () => {
  const g = globalThis as { sessionStorage?: unknown };
  const hadSession = 'sessionStorage' in g;
  beforeAll(() => {
    if (!hadSession) g.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  });
  afterAll(() => {
    if (!hadSession) delete g.sessionStorage;
  });

  const setup = () => {
    let refuse = false;
    const stored = new Map<string, string>();
    const hub = new Hub(
      async () => undefined,
      {
        load: async () => ({}),
        apply: async (sets, removes) => {
          if (refuse) throw new Error('refused');
          for (const [k, v] of Object.entries(sets)) stored.set(k, v);
          for (const k of removes) stored.delete(k);
        },
      },
      { persistSession: false },
    );
    const results: string[] = [];
    let reqId = 0;
    hub.register('bg', {
      sender: { id: 'x', url: 'u', origin: 'o' },
      post: (j) => {
        const m = JSON.parse(j) as { t: string; error?: string; result?: Record<string, unknown> };
        if (m.t === 'storageResult') results.push(m.error ?? JSON.stringify(m.result ?? null));
      },
    });
    const op = (op: 'get' | 'set', arg: unknown) =>
      hub.handle('bg', { t: 'storage', reqId: ++reqId, area: 'local', op, arg } as never);
    return { hub, stored, results, op, refuse: (on: boolean) => (refuse = on) };
  };

  test('reviewer probe: a refused write, then a good one: the good one is saved', async () => {
    const h = setup();
    h.refuse(true);
    await h.op('set', { a: 1 });
    h.refuse(false);
    await h.op('set', { b: 2 });
    expect(h.results[0]).toContain('refused');
    expect(h.results[1]).toBe('null');
    expect([...h.stored.keys()]).toEqual(['chrome.storage.local:b']);
  });

  test('a refused write is taken back out of the hub copy, so reads match what is stored', async () => {
    const h = setup();
    await h.op('set', { a: 1 });
    h.refuse(true);
    await h.op('set', { a: 2, c: 3 });
    h.refuse(false);
    await h.op('get', ['a', 'c']);
    expect(JSON.parse(h.results.at(-1)!)).toEqual({ a: 1 });
  });

  test('writes still reach the backend in order, and flush() waits for them', async () => {
    const order: string[] = [];
    const hub = new Hub(
      async () => undefined,
      {
        load: async () => ({}),
        apply: async (sets) => {
          await new Promise((r) => setTimeout(r, Object.keys(sets).includes('chrome.storage.local:slow') ? 30 : 0));
          order.push(...Object.keys(sets));
        },
      },
      { persistSession: false },
    );
    hub.register('bg', { sender: { id: 'x', url: 'u', origin: 'o' }, post: () => undefined });
    void hub.handle('bg', { t: 'storage', reqId: 1, area: 'local', op: 'set', arg: { slow: 1 } } as never);
    void hub.handle('bg', { t: 'storage', reqId: 2, area: 'local', op: 'set', arg: { fast: 1 } } as never);
    await new Promise((r) => setTimeout(r, 0));
    await hub.flush();
    expect(order).toEqual(['chrome.storage.local:slow', 'chrome.storage.local:fast']);
  });

  test('quiet() waits for running and recent storage ops, up to its cap', async () => {
    const h = setup();
    const t0 = Date.now();
    await h.hub.quiet(30, 1000); // nothing has run: at once
    expect(Date.now() - t0).toBeLessThan(25);
    void h.op('set', { a: 1 });
    const t1 = Date.now();
    await h.hub.quiet(60, 1000);
    expect(Date.now() - t1).toBeGreaterThanOrEqual(55);
    const t2 = Date.now();
    const busy = setInterval(() => void h.op('set', { tick: Date.now() }), 10);
    await h.hub.quiet(60, 150); // never quiet: the cap ends the wait
    clearInterval(busy);
    expect(Date.now() - t2).toBeLessThan(400);
  });
});
