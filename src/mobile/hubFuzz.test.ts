/**
 * Fuzz (reviewer's zzProbe5, 13 Nov 2026): random interleavings of sets, removes and refused writes against one hub,
 * and random multi-key writes against a byte quota. Invariants: after everything settles, the hub's copy equals what
 * is stored, and what is stored is the value of the last op answered "ok" (or the start value); a failed atomic
 * write leaves storage exactly as before. Seeded, so a failure reproduces.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { applyAtomically } from './atomicStorage';
import { Hub, type LocalBackend } from './hub';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const prng = (seed: number) => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

describe('storage fuzz', () => {
  const g = globalThis as { sessionStorage?: unknown };
  const hadSession = 'sessionStorage' in g;
  beforeAll(() => {
    if (!hadSession) g.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  });
  afterAll(() => {
    if (!hadSession) delete g.sessionStorage;
  });

  test('applyAtomically under a byte quota: a throw always leaves storage exactly as before', () => {
    const rnd = prng(12345);
    let bad = 0;
    for (let iter = 0; iter < 20000; iter++) {
      const Q = 60;
      const items = new Map<string, string>();
      const used = () => [...items].reduce((t, [k, v]) => t + k.length + v.length, 0);
      const st = {
        getItem: (k: string) => items.get(k) ?? null,
        setItem: (k: string, v: string) => {
          const prev = items.get(k);
          const after = used() - (prev === undefined ? 0 : k.length + prev.length) + k.length + v.length;
          if (after > Q) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
          items.set(k, v);
        },
        removeItem: (k: string) => void items.delete(k),
      };
      const keys = ['a', 'b', 'c', 'd'];
      for (const k of keys)
        if (rnd() < 0.7)
          try {
            st.setItem(k, 'x'.repeat(Math.floor(rnd() * 15)));
          } catch {
            /* full */
          }
      const before = JSON.stringify([...items].sort());
      const sets: Record<string, string> = {};
      const removes: string[] = [];
      for (const k of keys) {
        const r = rnd();
        if (r < 0.4) sets[k] = 'y'.repeat(Math.floor(rnd() * 25));
        else if (r < 0.55) removes.push(k);
      }
      try {
        applyAtomically(st, sets, removes);
      } catch {
        if (JSON.stringify([...items].sort()) !== before) bad++;
      }
    }
    expect(bad).toBe(0);
  });

  for (const fresh of [false, true])
    test(`hub (${fresh ? 'fresh key' : 'plain key'}): after settling, copy == stored == last "ok" op`, async () => {
      const rnd = prng(fresh ? 777 : 12345);
      const failures: string[] = [];
      for (let iter = 0; iter < 1500; iter++) {
        const disk = new Map<string, string>([['chrome.storage.local:x', '"a"']]);
        const backend: LocalBackend = {
          load: async () => Object.fromEntries(disk),
          apply: async (sets, removes) => {
            await tick(Math.floor(rnd() * 3));
            if (rnd() < 0.35) throw new Error('refused');
            for (const k of removes) disk.delete(k);
            for (const [k, v] of Object.entries(sets)) disk.set(k, v);
          },
          loadKeys: async (ks) => Object.fromEntries(ks.map((k) => [k, disk.get(k) ?? null])),
        };
        const hub = new Hub(async () => undefined, backend, {
          persistSession: false,
          freshLocalKeys: fresh ? (k) => k === 'x' : undefined,
        });
        const res = new Map<number, string>();
        let mem: unknown = 'unread';
        hub.register('bg', {
          sender: { id: 'x', url: 'u', origin: 'o' },
          post: (j) => {
            const m = JSON.parse(j) as { t: string; reqId: number; error?: string; result?: { x?: unknown } };
            if (m.t !== 'storageResult') return;
            res.set(m.reqId, m.error ?? 'ok');
            if (m.reqId === 999) mem = m.result?.x;
          },
        });
        const ops: Array<{ id: number; v: string | null }> = [];
        const ps: Promise<unknown>[] = [];
        const n = 2 + Math.floor(rnd() * 4);
        for (let i = 1; i <= n; i++) {
          const v = rnd() < 0.15 ? null : ['a', 'v', 'w'][Math.floor(rnd() * 3)];
          ops.push({ id: i, v });
          ps.push(
            hub.handle(
              'bg',
              (v === null
                ? { t: 'storage', reqId: i, area: 'local', op: 'remove', arg: 'x' }
                : { t: 'storage', reqId: i, area: 'local', op: 'set', arg: { x: v } }) as never,
            ),
          );
          if (rnd() < 0.5) await tick(0);
        }
        await Promise.all(ps);
        await tick(5);
        await hub.handle('bg', { t: 'storage', reqId: 999, area: 'local', op: 'get', arg: 'x' } as never);
        const d = disk.get('chrome.storage.local:x');
        const stored = d === undefined ? undefined : JSON.parse(d);
        const lastOk = [...ops].reverse().find((o) => res.get(o.id) === 'ok');
        const expected = lastOk ? (lastOk.v === null ? undefined : lastOk.v) : 'a';
        if (JSON.stringify(mem) !== JSON.stringify(stored) || JSON.stringify(stored) !== JSON.stringify(expected))
          failures.push(JSON.stringify({ ops: ops.map((o) => `${o.v}:${res.get(o.id)}`), mem, stored, expected }));
      }
      expect(failures.slice(0, 5)).toEqual([]);
      expect(failures.length).toBe(0);
    }, 60_000);
});
