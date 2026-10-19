import { describe, expect, test } from 'bun:test';
import { AUTO_RESYNC_KEY, autoResyncCoins, runAutoResyncIfDue, type AutoResyncDeps } from './autoCoinResync';
import { withCoinResyncLock } from './coinResyncLock';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const S = 'd'.repeat(64);
const OWN = 'e'.repeat(64);

const deps = (over: Partial<AutoResyncDeps> = {}) => {
  const spent: Record<string, string> = {};
  const unspent: string[] = [];
  const d: AutoResyncDeps = {
    coins: [],
    cleared: {},
    ownPendingTxids: new Set(),
    ownPendingInputs: new Set(),
    getSpends: async (b) => b.map(() => null),
    markSpent: async (o, by) => ((spent[o] = by), 1),
    markUnspent: async (o) => (unspent.push(o), 1),
    ...over,
  };
  return { d, spent, unspent };
};

describe('autoResyncCoins', () => {
  test('1sat index spender clears the coin and is remembered', async () => {
    const { d, spent } = deps({
      coins: [`${A}_0`, `${B}_1`],
      getSpends: async (b) => b.map((o) => (o.startsWith(A) ? S : null)),
    });
    const r = await autoResyncCoins(d);
    expect(spent).toEqual({ [`${A}_0`]: S });
    expect(r.cleared).toEqual({ [`${A}_0`]: S });
    expect(r.released).toBe(1);
  });

  test('mempool-only WhatsOnChain spender never clears; confirmed does', async () => {
    const mem = deps({ coins: [`${A}_0`], woc: async () => ({ txid: S, confirmed: false }) });
    expect((await autoResyncCoins(mem.d)).released).toBe(0);
    const conf = deps({ coins: [`${A}_0`], woc: async () => ({ txid: S, confirmed: true }) });
    expect((await autoResyncCoins(conf.d)).released).toBe(1);
  });

  test('index failure leaves coins alone (fail closed), no WoC fallback asked', async () => {
    let asked = 0;
    const { d, spent } = deps({
      coins: [`${A}_0`],
      getSpends: async () => {
        throw new Error('boom');
      },
      woc: async () => (asked++, { txid: S, confirmed: true }),
    });
    await autoResyncCoins(d);
    expect(spent).toEqual({});
    expect(asked).toBe(0);
  });

  test("own unfinished actions: their txid is no spender, their inputs aren't checked", async () => {
    const { d, spent } = deps({
      coins: [`${A}_0`, `${B}_0`],
      ownPendingTxids: new Set([OWN]),
      ownPendingInputs: new Set([`${B}_0`]),
      getSpends: async (b) => b.map((o) => (o.startsWith(A) ? OWN : S)),
    });
    const r = await autoResyncCoins(d);
    expect(spent).toEqual({});
    expect(r.checked).toBe(1);
  });

  test('a cleared coin both lookups now call unspent is restored', async () => {
    const { d, unspent } = deps({ cleared: { [`${C}_2`]: S }, woc: async () => null });
    const r = await autoResyncCoins(d);
    expect(unspent).toEqual([`${C}_2`]);
    expect(r.restored).toBe(1);
    expect(r.cleared).toEqual({});
  });

  test('restore needs WoC to agree (fail closed)', async () => {
    const { d, unspent } = deps({ cleared: { [`${C}_2`]: S }, woc: async () => ({ txid: S, confirmed: false }) });
    await autoResyncCoins(d);
    expect(unspent).toEqual([]);
  });

  test('batches of 100 to the index', async () => {
    const sizes: number[] = [];
    const coins = Array.from({ length: 250 }, (_, i) => `${A}_${i}`);
    const { d } = deps({ coins, getSpends: async (b) => (sizes.push(b.length), b.map(() => null)) });
    await autoResyncCoins(d);
    expect(sizes.sort((x, y) => x - y)).toEqual([50, 100, 100]);
  });
});

describe('index replies: only an explicit null is unspent', () => {
  test('short reply: nothing restored, nothing cleared', async () => {
    const { d, unspent, spent } = deps({
      coins: [`${A}_0`],
      cleared: { [`${C}_2`]: S },
      getSpends: async () => [],
    });
    const r = await autoResyncCoins(d);
    expect(unspent).toEqual([]);
    expect(spent).toEqual({});
    expect(r.cleared).toEqual({ [`${C}_2`]: S });
  });
  test('undefined entry is unknown, not unspent', async () => {
    const { d, unspent } = deps({ cleared: { [`${C}_2`]: S }, getSpends: async (b) => b.map(() => undefined) });
    await autoResyncCoins(d);
    expect(unspent).toEqual([]);
  });
  test('explicit null (and WoC 404) restores', async () => {
    const { d, unspent } = deps({ cleared: { [`${C}_2`]: S }, woc: async () => null });
    await autoResyncCoins(d);
    expect(unspent).toEqual([`${C}_2`]);
  });
});

describe('runAutoResyncIfDue', () => {
  test('not ready (load null) does not start the wait', async () => {
    const m: Record<string, unknown> = {};
    const kv = {
      get: async (k: string) => ({ [k]: m[k] }),
      set: async (i: Record<string, unknown>) => void Object.assign(m, i),
    };
    expect(await runAutoResyncIfDue('k', kv, async () => null, 1)).toBeNull();
    expect(await runAutoResyncIfDue('k', kv, async () => deps().d, 2)).not.toBeNull();
  });

  const memKV = () => {
    const m: Record<string, unknown> = {};
    return {
      m,
      kv: {
        get: async (k: string) => ({ [k]: m[k] }),
        set: async (i: Record<string, unknown>) => void Object.assign(m, i),
      },
    };
  };

  test('throttle is persisted: a new worker (same storage) waits the gap', async () => {
    const { m, kv } = memKV();
    let runs = 0;
    const load = async () => (runs++, deps({ coins: [] }).d);
    expect(await runAutoResyncIfDue('k', kv, load, 1_000)).not.toBeNull();
    expect(await runAutoResyncIfDue('k', kv, load, 2_000)).toBeNull();
    expect(runs).toBe(1);
    expect((m[AUTO_RESYNC_KEY] as Record<string, { at: number }>).k.at).toBe(1_000);
    expect(await runAutoResyncIfDue('k', kv, load, 1_000 + 30 * 60 * 1000)).not.toBeNull();
    expect(await runAutoResyncIfDue('other', kv, load, 2_000)).not.toBeNull();
  });

  test('cleared list is persisted and fed to the next run', async () => {
    const { m, kv } = memKV();
    await runAutoResyncIfDue(
      'k',
      kv,
      async () => deps({ coins: [`${A}_0`], getSpends: async (b) => b.map(() => S) }).d,
      0,
    );
    expect((m[AUTO_RESYNC_KEY] as Record<string, { cleared: Record<string, string> }>).k.cleared).toEqual({
      [`${A}_0`]: S,
    });
    let seen: Record<string, string> = {};
    await runAutoResyncIfDue('k', kv, async (c) => ((seen = c), deps().d), 10 * 60 * 60 * 1000);
    expect(seen).toEqual({ [`${A}_0`]: S });
  });
});

describe('withCoinResyncLock', () => {
  test('runs one at a time, survives a throw', async () => {
    const order: string[] = [];
    const slow = withCoinResyncLock(async () => {
      order.push('a1');
      await new Promise((r) => setTimeout(r, 20));
      order.push('a2');
      throw new Error('x');
    }).catch(() => undefined);
    const fast = withCoinResyncLock(async () => order.push('b'));
    await Promise.all([slow, fast]);
    expect(order).toEqual(['a1', 'a2', 'b']);
  });
});
