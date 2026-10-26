import { describe, expect, test } from 'bun:test';
import { singleFlight } from './addressResync';
import { isRetryable, prioritySync, type PrioritySyncDeps, type SyncOutputLike } from './prioritySync';

const txid = (n: number) => n.toString(16).padStart(64, '0');
const noSleep = async () => undefined;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const memStore = (done: Set<string> = new Set()) => {
  let score = 0;
  return {
    done,
    has: async (t: string) => done.has(t),
    add: async (t: string) => void done.add(t),
    getLastScore: async () => score,
    setLastScore: async (s: number) => void (score = s),
    score: () => score,
  };
};

/** A wallet like the owner's: a handful of coin transactions buried among thousands of 1-sat names. */
const bigWallet = (names: number, coins: number) => {
  const outs: SyncOutputLike[] = [];
  const coinIds = new Set<string>();
  const every = Math.floor((names + coins) / coins);
  for (let i = 0; i < names + coins; i++) {
    const t = txid(i + 1);
    if (i % every === every - 1 && coinIds.size < coins) coinIds.add(t);
    outs.push({ outpoint: `${t}_0`, score: 800_000 + i });
  }
  return { outs, coinIds };
};

const deps = (
  outs: SyncOutputLike[],
  coinIds: Set<string>,
  over: Partial<PrioritySyncDeps> & { store?: ReturnType<typeof memStore> } = {},
) => {
  const store = over.store ?? memStore();
  const balance = { sats: 0 };
  const d: PrioritySyncDeps = {
    addresses: ['1a', '1b'],
    height: 900_000,
    store,
    stream: async function* () {
      for (const o of outs) yield o;
    },
    ourOutputs: async (t) => (coinIds.has(t) ? [1_000_000] : [1]),
    fetchBeef: async () => [1],
    internalize: async (t) => {
      await wait(1); // each internalization takes time, as wallet storage does
      if (coinIds.has(t)) balance.sats += 1_000_000;
    },
    sleep: noSleep,
    ...over,
  };
  return { d, store, balance };
};

describe('prioritySync', () => {
  test('a restore with thousands of names: the full balance is in before any name loads', async () => {
    const { outs, coinIds } = bigWallet(3000, 20);
    let balanceAtCoinsReady = -1;
    let namesInternalizedAtCoinsReady = -1;
    let namesInternalized = 0;
    const { d, balance } = deps(outs, coinIds);
    const inner = d.internalize;
    d.internalize = async (t, b) => {
      await inner(t, b);
      if (!coinIds.has(t)) namesInternalized++;
    };
    d.onCoinsReady = () => {
      balanceAtCoinsReady = balance.sats;
      namesInternalizedAtCoinsReady = namesInternalized;
    };
    const t0 = performance.now();
    let coinsMs = 0;
    const prev = d.onCoinsReady;
    d.onCoinsReady = (r) => {
      coinsMs = performance.now() - t0;
      prev(r);
    };
    const r = await prioritySync(d);
    const totalMs = performance.now() - t0;
    expect(balanceAtCoinsReady).toBe(20 * 1_000_000);
    expect(namesInternalizedAtCoinsReady).toBe(0);
    expect(r.coins.found).toBe(20);
    expect(r.names.total).toBe(3000);
    expect(r.failed).toBe(0);
    // Coins need ~20 internalizations, names ~3000: the balance arrives in a small slice of the run.
    expect(coinsMs).toBeLessThan(totalMs / 5);
    // Before: the stock action internalized every transaction one by one in stream order (same 1 ms each).
    const b0 = performance.now();
    let oldBalanceMs = 0;
    let got = 0;
    for (const o of outs) {
      await wait(1);
      if (coinIds.has(o.outpoint.slice(0, 64)) && ++got === coinIds.size) oldBalanceMs = performance.now() - b0;
    }
    console.log(`[timing] before: balance complete after ${oldBalanceMs.toFixed(0)} ms`);
    console.log(`[timing] after: balance complete after ${coinsMs.toFixed(0)} ms; whole sync ${totalMs.toFixed(0)} ms`);
  }, 60_000);

  test('a 429 or timeout on names never blocks the balance', async () => {
    const { outs, coinIds } = bigWallet(200, 5);
    let coinsReady = false;
    const { d, balance } = deps(outs, coinIds, {
      fetchBeef: async (t) => {
        if (!coinIds.has(t)) throw new Error(Math.random() < 0.5 ? 'Request failed: 429' : 'timeout');
        return [1];
      },
    });
    d.onCoinsReady = () => (coinsReady = true);
    const r = await prioritySync(d);
    expect(coinsReady).toBe(true);
    expect(balance.sats).toBe(5 * 1_000_000);
    expect(r.coins.failed).toBe(0);
    expect(r.names.failed).toBe(200);
  });

  test('rate limits are retried, so a passing 429 loses nothing', async () => {
    const { outs, coinIds } = bigWallet(30, 3);
    const tries = new Map<string, number>();
    const { d } = deps(outs, coinIds, {
      ourOutputs: async (t) => {
        const n = (tries.get(t) ?? 0) + 1;
        tries.set(t, n);
        if (n === 1) throw new Error('429 Too Many Requests');
        return coinIds.has(t) ? [5000] : [1];
      },
    });
    const r = await prioritySync(d);
    expect(r.failed).toBe(0);
    expect(r.processed).toBe(33);
  });

  test('fetches run in parallel, capped', async () => {
    const { outs, coinIds } = bigWallet(60, 2);
    let inFlight = 0;
    let peak = 0;
    const { d } = deps(outs, coinIds, {
      concurrency: 6,
      ourOutputs: async (t) => {
        peak = Math.max(peak, ++inFlight);
        await wait(2);
        inFlight--;
        return coinIds.has(t) ? [5000] : [1];
      },
    });
    await prioritySync(d);
    expect(peak).toBe(6);
  });

  test('retry is not a no-op: a second run redoes exactly what failed', async () => {
    const { outs, coinIds } = bigWallet(50, 5);
    const store = memStore();
    let down = true;
    const internalized: string[] = [];
    const { d } = deps(outs, coinIds, {
      store,
      fetchBeef: async (t) => {
        if (down && !coinIds.has(t)) throw new Error('names indexer: 503');
        return [1];
      },
      internalize: async (t) => void internalized.push(t),
    });
    const first = await prioritySync(d);
    expect(first.names.failed).toBe(50);
    expect(store.score()).toBe(0); // the cursor holds back while anything failed
    internalized.length = 0;
    down = false;
    const second = await prioritySync(d);
    expect(second.failed).toBe(0);
    expect(internalized.length).toBe(50); // only the names; the coins were already done
    expect(internalized.every((t) => !coinIds.has(t))).toBe(true);
    expect(store.score()).toBeGreaterThan(0);
  });

  test('retry after the run ends starts a new run (the shared single flight is not cached)', async () => {
    let runs = 0;
    const f = singleFlight(async () => void runs++);
    await f.run();
    await f.run();
    expect(runs).toBe(2);
  });

  test('a run cut short resumes from what it saved', async () => {
    const { outs, coinIds } = bigWallet(100, 4);
    const store = memStore();
    let n = 0;
    const { d } = deps(outs, coinIds, {
      store,
      internalize: async () => {
        if (++n > 40) throw new Error('service worker stopped'); // not retryable
      },
    });
    await prioritySync(d);
    expect(store.done.size).toBe(40);
    const seen: string[] = [];
    d.internalize = async (t) => void seen.push(t);
    const r = await prioritySync(d);
    expect(seen.length).toBe(64);
    expect(r.failed).toBe(0);
  });

  test('progress names the part and counts real work', async () => {
    const { outs, coinIds } = bigWallet(10, 2);
    const msgs: string[] = [];
    const { d } = deps(outs, coinIds, { onProgress: (p) => msgs.push(p.message) });
    await prioritySync(d);
    expect(msgs.some((m) => m.startsWith('Finding coins…'))).toBe(true);
    expect(msgs).toContain('Loading names 10 of 10');
  });

  test('spent outputs and already-processed transactions are skipped', async () => {
    const outs = [
      { outpoint: `${txid(1)}_0`, score: 1, spendTxid: txid(9) },
      { outpoint: `${txid(2)}_0`, score: 2 },
    ];
    const { d } = deps(outs, new Set([txid(2)]), { store: memStore(new Set([txid(2)])) });
    const r = await prioritySync(d);
    expect(r.processed).toBe(0);
  });

  test('which errors are worth retrying', () => {
    expect(isRetryable(new Error('Request failed: 429'))).toBe(true);
    expect(isRetryable(new Error('The operation timed out'))).toBe(true);
    expect(isRetryable(new Error('Failed to fetch'))).toBe(true);
    expect(isRetryable(new Error('invalid beef'))).toBe(false);
  });
});
