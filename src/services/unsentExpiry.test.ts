import { beforeEach, describe, expect, test } from 'bun:test';
import {
  DEFAULT_TTL_S,
  MAX_HOLD_S,
  STORE_MIN_AGE_S,
  STORE_OTHER_DEVICE_TTL_S,
  WATCH_S,
  storageReaffirmSpent,
  conflictCheck,
  emptyState,
  expireOnce,
  isExpired,
  policyFromLabels,
  resetExpiryLimit,
  runUnsentExpiry,
  splitOutpoint,
  storageDetachInput,
  wocHeight,
  wocSpent,
  type ExpiryDeps,
  type ExpiryState,
  type NoSendAction,
  type SpendState,
  type StoreKind,
  type StoreWord,
} from './unsentExpiry';
import type { Sighting } from './unsentGuard';

const T = (c: string) => c.repeat(64);
const A = T('a');
const B = T('b');
const P = T('1'); // a mined parent
const Q = T('2'); // another mined parent
const X = T('9'); // someone else's tx
const Y = T('8'); // another one

/** A fake world: which txids the chain has, and who spent which outpoint. */
function world() {
  const seen = new Set<string>([P, Q]);
  const spends = new Map<string, string>();
  const unclear = new Set<string>();
  const aborted: string[] = [];
  const sent: string[] = [];
  const recovered: string[] = [];
  const logs: string[] = [];
  let state: ExpiryState | null = null;
  let now = 1_800_000_000;
  let actions: NoSendAction[] = [];
  const look = async (txid: string): Promise<Sighting> =>
    unclear.has(txid) ? 'unclear' : seen.has(txid) ? 'seen' : 'missing';
  const deps: ExpiryDeps = {
    listNoSend: async () => actions,
    abort: async (t) => {
      aborted.push(t);
      actions = actions.filter((a) => a.txid !== t);
    },
    sendWith: async (t) => void sent.push(t),
    recoverLate: async (t) => void recovered.push(t),
    kv: { load: async () => (state ? structuredClone(state) : null), save: async (s) => void (state = s) },
    lookups: [look, look],
    spent: async (o): Promise<SpendState> => {
      if (unclear.has(o)) return { state: 'unclear' };
      const by = spends.get(o);
      return by ? { state: 'spent', by } : { state: 'unspent' };
    },
    nowS: () => now,
    delaysMs: [0, 1, 1],
    sleep: async () => undefined,
    log: (m) => logs.push(m),
  };
  return {
    deps,
    seen,
    spends,
    unclear,
    aborted,
    sent,
    recovered,
    logs,
    get state() {
      return state;
    },
    set actions(a: NoSendAction[]) {
      actions = a;
    },
    advance: (s: number) => (now += s),
  };
}

const act = (txid: string, ins: string[], labels?: string[]): NoSendAction => ({
  txid,
  labels,
  inputs: ins.map((sourceOutpoint) => ({ sourceOutpoint })),
});

beforeEach(() => resetExpiryLimit());

describe('BRC-177 labels', () => {
  test('exact forms parse; others fall back to the default deadline', () => {
    expect(policyFromLabels(undefined)).toEqual({ mode: 'default' });
    expect(policyFromLabels(['offer 42'])).toEqual({ mode: 'default' });
    expect(policyFromLabels(['p nosend expiry seconds 300'])).toEqual({ mode: 'seconds', value: 300 });
    expect(policyFromLabels(['p nosend expiry timestamp 1798761600'])).toEqual({
      mode: 'timestamp',
      value: 1798761600,
    });
    expect(policyFromLabels(['p nosend expiry blockheight 1000000'])).toEqual({ mode: 'blockheight', value: 1000000 });
    expect(policyFromLabels(['p nosend expiry never'])).toEqual({ mode: 'never' });
    for (const bad of [
      'p nosend expiry seconds 0',
      'p nosend expiry seconds 007',
      'p nosend expiry seconds -5',
      'p nosend expiry Seconds 5',
      'p nosend expiry  seconds 5',
      'p nosend expiry never 0',
      'p nosend expiry fortnight 1',
      'p nosend expiry seconds 99999999999999999999',
    ])
      expect(policyFromLabels([bad]).mode).toBe('default');
    expect(policyFromLabels(['p nosend expiry seconds 5', 'p nosend expiry seconds 6']).invalid).toMatch(/duplicate/);
  });

  test('deadlines: relative from first sight, absolute time, block height, never', () => {
    expect(isExpired({ mode: 'default' }, 100, 100 + DEFAULT_TTL_S - 1, undefined)).toBe(false);
    expect(isExpired({ mode: 'default' }, 100, 100 + DEFAULT_TTL_S, undefined)).toBe(true);
    expect(isExpired({ mode: 'seconds', value: 300 }, 100, 399, undefined)).toBe(false);
    expect(isExpired({ mode: 'seconds', value: 300 }, 100, 400, undefined)).toBe(true);
    expect(isExpired({ mode: 'timestamp', value: 500 }, 0, 499, undefined)).toBe(false);
    expect(isExpired({ mode: 'timestamp', value: 500 }, 0, 500, undefined)).toBe(true);
    expect(isExpired({ mode: 'blockheight', value: 10 }, 9e9 - 100, 9e9, undefined)).toBe(false); // no height: never early (within the 14-day cap)
    expect(isExpired({ mode: 'blockheight', value: 10 }, 0, 0, 9)).toBe(false);
    expect(isExpired({ mode: 'blockheight', value: 10 }, 0, 0, 10)).toBe(true);
    expect(isExpired({ mode: 'never' }, 9e12 - 100, 9e12, 9e9)).toBe(false); // within the 14-day cap
  });

  test('outpoints', () => {
    expect(splitOutpoint(`${P}.3`)).toEqual([P, 3]);
    expect(splitOutpoint(`${P.toUpperCase()}_0`)).toEqual([P, 0]);
    expect(splitOutpoint('nope.1')).toBeUndefined();
  });
});

describe('expiry and release', () => {
  test('before the deadline nothing happens; the first-seen time is persisted and never restarts', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`])];
    let r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'not-due' }]);
    const first = w.state!.first[A];
    w.advance(DEFAULT_TTL_S - 10);
    r = await expireOnce(w.deps);
    expect(w.state!.first[A]).toBe(first);
    expect(w.aborted).toEqual([]);
    w.advance(10);
    r = await expireOnce(w.deps);
    expect(r.released).toEqual([A]);
    expect(w.aborted).toEqual([A]);
    expect(w.state!.released[A]).toBeDefined();
  });

  test('released only when every input is unspent, its parent is on chain and the tx is missing everywhere', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`, `${Q}.1`], ['p nosend expiry seconds 60'])];
    await expireOnce(w.deps);
    w.advance(60);
    const r = await expireOnce(w.deps);
    expect(r.released).toEqual([A]);
    expect(w.logs.some((l) => l.includes('released (aborted)'))).toBe(true);
  });

  test('CRITICAL: the original is on chain (seen) → never released, handed to sendWith', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`], ['p nosend expiry seconds 1'])];
    await expireOnce(w.deps);
    w.advance(5);
    w.seen.add(A);
    const r = await expireOnce(w.deps);
    expect(w.aborted).toEqual([]);
    expect(r.settled).toEqual([A]);
    expect(w.sent).toEqual([A]);
  });

  test('CRITICAL: an input spent by the original (indexer lag on the tx itself) → settle, never release', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`], ['p nosend expiry seconds 1'])];
    await expireOnce(w.deps);
    w.advance(5);
    w.spends.set(`${P}.0`, A);
    const r = await expireOnce(w.deps);
    expect(w.aborted).toEqual([]);
    expect(r.settled).toEqual([A]);
  });

  test('CRITICAL: an input spent by something else, or any unclear answer → kept, nothing aborted', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`], ['p nosend expiry seconds 1'])];
    await expireOnce(w.deps);
    w.advance(5);
    w.spends.set(`${P}.0`, X);
    let r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'input-spent-elsewhere' }]);
    w.spends.clear();
    w.unclear.add(`${P}.0`);
    r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'input-unclear' }]);
    w.unclear.clear();
    w.unclear.add(A); // a lookup that can't answer for the tx itself
    r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'chain-has-it-or-unclear' }]);
    expect(w.aborted).toEqual([]);
  });

  test('CRITICAL: a parent the chain has never heard of (404 spent lookup on a phantom outpoint) → kept', async () => {
    const w = world();
    const ghost = T('7');
    w.actions = [act(A, [`${ghost}.0`], ['p nosend expiry seconds 1'])];
    await expireOnce(w.deps);
    w.advance(5);
    const r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'parent-unknown' }]);
    expect(w.aborted).toEqual([]);
  });

  test('CRITICAL: the tx appears during the ~30 s retry window → kept', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`], ['p nosend expiry seconds 1'])];
    await expireOnce(w.deps);
    w.advance(5);
    let calls = 0;
    w.deps.lookups = [
      async (t) => {
        if (t !== A) return w.seen.has(t) ? 'seen' : 'missing';
        return ++calls > 2 ? 'seen' : 'missing';
      },
    ];
    const r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'chain-has-it-or-unclear' }]);
    expect(w.aborted).toEqual([]);
  });

  test('CRITICAL: an input gets spent between the check and the release → kept (re-check before abort)', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`], ['p nosend expiry seconds 1'])];
    await expireOnce(w.deps);
    w.advance(5);
    let n = 0;
    const base = w.deps.spent!;
    w.deps.spent = async (o) => (++n > 1 ? { state: 'spent', by: X } : base(o));
    const r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'changed-at-recheck' }]);
    expect(w.aborted).toEqual([]);
  });

  test('never: no deadline, no release', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`], ['p nosend expiry never'])];
    await expireOnce(w.deps);
    w.advance(10 * DEFAULT_TTL_S);
    const r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'never' }]);
    expect(w.aborted).toEqual([]);
  });

  test('no inputs listed → kept (nothing to check on chain)', async () => {
    const w = world();
    w.actions = [{ txid: A, labels: ['p nosend expiry seconds 1'] }];
    await expireOnce(w.deps);
    w.advance(5);
    expect((await expireOnce(w.deps)).kept).toEqual([{ txid: A, reason: 'no-inputs' }]);
  });

  test('a chain of our own nosend txs is released together, child first', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`]), act(B, [`${A}.1`])];
    await expireOnce(w.deps);
    w.advance(DEFAULT_TTL_S);
    const r = await expireOnce(w.deps);
    expect(r.released.sort()).toEqual([A, B].sort());
    expect(w.aborted).toEqual([B, A]);
  });

  test('a child whose own-parent is not due holds; the parent is not dragged along', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`], ['p nosend expiry never']), act(B, [`${A}.1`], ['p nosend expiry seconds 1'])];
    await expireOnce(w.deps);
    w.advance(5);
    const r = await expireOnce(w.deps);
    expect(r.kept).toContainEqual({ txid: B, reason: 'parent-unknown' });
    expect(w.aborted).toEqual([]);
  });

  test('a child that cannot be released does not hold back a clean parent', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`]), act(B, [`${A}.1`, `${Q}.0`])];
    await expireOnce(w.deps);
    w.advance(DEFAULT_TTL_S);
    w.spends.set(`${Q}.0`, X); // the child's other input went elsewhere
    const r = await expireOnce(w.deps);
    expect(r.kept).toContainEqual({ txid: B, reason: 'input-spent-elsewhere' });
    // A (parent) has B depending on it, but B is out of the set; A alone is still releasable: B can never be valid
    // without A, and A's own inputs are clean.
    expect(w.aborted).toEqual([A]);
  });

  test('abort refused → kept, retried next run', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`], ['p nosend expiry seconds 1'])];
    w.deps.abort = async () => {
      throw new Error('busy');
    };
    await expireOnce(w.deps);
    w.advance(5);
    const r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'abort-failed' }]);
    expect(w.state!.released[A]).toBeUndefined();
  });
});

describe('after release (race at expiry)', () => {
  test('if the original shows up later, the wallet recovery runs; then it is no longer watched', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`], ['p nosend expiry seconds 1'])];
    await expireOnce(w.deps);
    w.advance(5);
    await expireOnce(w.deps);
    expect(w.aborted).toEqual([A]);
    w.advance(3600);
    expect((await expireOnce(w.deps)).lateSeen).toEqual([]);
    w.seen.add(A);
    const r = await expireOnce(w.deps);
    expect(r.lateSeen).toEqual([A]);
    expect(w.recovered).toEqual([A]);
    expect(w.state!.released[A]).toBeUndefined();
  });

  test('a failed recovery is retried; a watch older than WATCH_S is dropped', async () => {
    const w = world();
    const s = emptyState();
    s.released[A] = 1_800_000_000;
    s.released[B] = 1_800_000_000 - WATCH_S - 1;
    await w.deps.kv.save(s);
    w.seen.add(A);
    w.seen.add(B);
    w.deps.recoverLate = async () => {
      throw new Error('offline');
    };
    const r = await expireOnce(w.deps);
    expect(r.lateSeen).toEqual([A]);
    expect(w.state!.released[A]).toBeDefined();
    expect(w.state!.released[B]).toBeUndefined();
  });

  test('a txid that left the nosend list is forgotten (sent or aborted elsewhere)', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`])];
    await expireOnce(w.deps);
    expect(w.state!.first[A]).toBeDefined();
    w.actions = [];
    await expireOnce(w.deps);
    expect(w.state!.first[A]).toBeUndefined();
  });
});

describe('runner', () => {
  test('rate-limited and single-flight', async () => {
    const w = world();
    w.actions = [];
    expect((await runUnsentExpiry(w.deps)).skipped).toBeUndefined();
    expect((await runUnsentExpiry(w.deps)).skipped).toBe('rate-limited');
    expect((await runUnsentExpiry(w.deps, { force: true })).skipped).toBeUndefined();
  });

  test('listing fails → nothing released, never throws', async () => {
    const w = world();
    w.deps.listNoSend = async () => {
      throw new Error('locked');
    };
    const r = await expireOnce(w.deps);
    expect(r.released).toEqual([]);
  });
});

describe('wocSpent', () => {
  const res = (status: number, body?: unknown) =>
    ({ status, ok: status >= 200 && status < 300, json: async () => body }) as Response;
  test('404 unspent, 200 spent by, else unclear', async () => {
    expect(await wocSpent(async () => res(404))(`${P}.0`)).toEqual({ state: 'unspent' });
    expect(await wocSpent(async () => res(200, { txid: A }))(`${P}.0`)).toEqual({ state: 'spent', by: A });
    expect(await wocSpent(async () => res(200, {}))(`${P}.0`)).toEqual({ state: 'unclear' });
    expect(await wocSpent(async () => res(429))(`${P}.0`)).toEqual({ state: 'unclear' });
    expect(
      await wocSpent(async () => {
        throw new Error('net');
      })(`${P}.0`),
    ).toEqual({ state: 'unclear' });
    expect(await wocSpent(async () => res(404))('bad')).toEqual({ state: 'unclear' });
  });
  test('asks the right URL', async () => {
    let url = '';
    await wocSpent(async (u) => {
      url = u;
      return res(404);
    })(`${P}.7`);
    expect(url).toBe(`https://api.whatsonchain.com/v1/bsv/main/tx/${P}/7/spent`);
  });
});

// b-Aware 26 Oct 2026 (N1): blockheight deadlines get a real height; every hold is capped at 14 days. Neither may
// release anything the chain checks would keep.
describe('BRC-177 block height and the 14-day cap', () => {
  const HEIGHT_LABEL = ['p nosend expiry blockheight 900000'];
  const withHeight = (w: ReturnType<typeof world>, h: () => Promise<number | undefined>) => {
    w.deps.height = h;
    return w;
  };

  test('wocHeight reads /chain/info blocks and fails closed to undefined', async () => {
    const res = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
    let url = '';
    expect(
      await wocHeight(async (u) => {
        url = u;
        return new Response(JSON.stringify({ blocks: 912345 }));
      })(),
    ).toBe(912345);
    expect(url).toBe('https://api.whatsonchain.com/v1/bsv/main/chain/info');
    expect(await wocHeight(res(500, { blocks: 1 }))()).toBeUndefined();
    expect(await wocHeight(res(200, { blocks: '912345' }))()).toBeUndefined();
    expect(await wocHeight(res(200, { blocks: -1 }))()).toBeUndefined();
    expect(await wocHeight(res(200, {}))()).toBeUndefined();
    expect(
      await wocHeight(async () => {
        throw new Error('offline');
      })(),
    ).toBeUndefined();
    expect(await wocHeight(async () => new Response('not json'))()).toBeUndefined();
  });

  test('height lookup fails → the blockheight action stays held (not due), nothing aborted', async () => {
    const w = withHeight(world(), async () => undefined);
    w.actions = [act(A, [`${P}.0`], HEIGHT_LABEL)];
    await expireOnce(w.deps);
    w.advance(DEFAULT_TTL_S * 3);
    const r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'not-due' }]);
    expect(w.aborted).toEqual([]);
  });

  test('height lookup throws → still held', async () => {
    const w = withHeight(world(), async () => {
      throw new Error('down');
    });
    w.actions = [act(A, [`${P}.0`], HEIGHT_LABEL)];
    const r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'not-due' }]);
    expect(w.aborted).toEqual([]);
  });

  test('below the height → not due; at the height with clean inputs → released through the normal checks', async () => {
    let h = 899_999;
    const w = withHeight(world(), async () => h);
    w.actions = [act(A, [`${P}.0`], HEIGHT_LABEL)];
    expect((await expireOnce(w.deps)).kept).toEqual([{ txid: A, reason: 'not-due' }]);
    h = 900_000;
    const r = await expireOnce(w.deps);
    expect(r.released).toEqual([A]);
    expect(w.aborted).toEqual([A]);
  });

  test('CRITICAL: height passed but an input is spent elsewhere → NOT released', async () => {
    const w = withHeight(world(), async () => 900_001);
    w.actions = [act(A, [`${P}.0`], HEIGHT_LABEL)];
    w.spends.set(`${P}.0`, X);
    const r = await expireOnce(w.deps);
    expect(r.released).toEqual([]);
    expect(w.aborted).toEqual([]);
    expect(r.kept.map((k) => k.txid)).toEqual([A]);
    expect(r.kept[0].reason).not.toBe('not-due');
  });

  test('CRITICAL: height passed but an input is spent by the original → settled via sendWith, NOT released', async () => {
    const w = withHeight(world(), async () => 900_001);
    w.actions = [act(A, [`${P}.0`], HEIGHT_LABEL)];
    w.spends.set(`${P}.0`, A);
    const r = await expireOnce(w.deps);
    expect(w.aborted).toEqual([]);
    expect(r.released).toEqual([]);
  });

  test('CRITICAL: height passed but an input is unclear → NOT released', async () => {
    const w = withHeight(world(), async () => 900_001);
    w.actions = [act(A, [`${P}.0`], HEIGHT_LABEL)];
    w.unclear.add(`${P}.0`);
    const r = await expireOnce(w.deps);
    expect(w.aborted).toEqual([]);
    expect(r.kept).toEqual([{ txid: A, reason: 'input-unclear' }]);
  });

  test('CRITICAL: height passed but the original is seen on chain → sendWith, NOT released', async () => {
    const w = withHeight(world(), async () => 900_001);
    w.actions = [act(A, [`${P}.0`], HEIGHT_LABEL)];
    w.seen.add(A);
    const r = await expireOnce(w.deps);
    expect(w.aborted).toEqual([]);
    expect(r.settled).toEqual([A]);
    expect(w.sent).toEqual([A]);
  });

  test('cap: never, a far timestamp, a far height and a long duration all come due at 14 days, not before', () => {
    const far = [
      { mode: 'never' as const },
      { mode: 'timestamp' as const, value: 9e12 },
      { mode: 'blockheight' as const, value: 9e9 },
      { mode: 'seconds' as const, value: 365 * 86400 },
    ];
    for (const p of far) {
      expect(isExpired(p, 100, 100 + MAX_HOLD_S - 1, undefined)).toBe(false);
      expect(isExpired(p, 100, 100 + MAX_HOLD_S, undefined)).toBe(true);
    }
    expect(MAX_HOLD_S).toBe(14 * 24 * 60 * 60);
  });

  test('never: held until 14 days, then released only if every chain check passes', async () => {
    const w = world();
    w.actions = [act(A, [`${P}.0`], ['p nosend expiry never'])];
    await expireOnce(w.deps);
    w.advance(MAX_HOLD_S - 1);
    expect((await expireOnce(w.deps)).kept).toEqual([{ txid: A, reason: 'never' }]);
    w.advance(1);
    const r = await expireOnce(w.deps);
    expect(r.released).toEqual([A]);
    expect(w.aborted).toEqual([A]);
  });

  test('CRITICAL: never past 14 days with an input spent or unclear, or the tx seen → NOT released', async () => {
    for (const twist of ['spent', 'unclear', 'seen'] as const) {
      const w = world();
      w.actions = [act(A, [`${P}.0`], ['p nosend expiry never'])];
      await expireOnce(w.deps);
      w.advance(MAX_HOLD_S + 60);
      if (twist === 'spent') w.spends.set(`${P}.0`, X);
      if (twist === 'unclear') w.unclear.add(`${P}.0`);
      if (twist === 'seen') w.seen.add(A);
      const r = await expireOnce(w.deps);
      expect(w.aborted).toEqual([]);
      expect(r.released).toEqual([]);
    }
  });

  test('CRITICAL: a height-expired action whose tx turns up during the 404 retries is NOT released', async () => {
    const w = withHeight(world(), async () => 900_001);
    w.actions = [act(A, [`${P}.0`], HEIGHT_LABEL)];
    let calls = 0;
    const lateLook = async (t: string): Promise<Sighting> => (t === A && ++calls > 2 ? 'seen' : 'missing');
    w.deps.lookups = [lateLook];
    const r = await expireOnce(w.deps);
    expect(w.aborted).toEqual([]);
    expect(r.released).toEqual([]);
  });
});

// ── 13 Nov 2026 (tx 446): a payment one of whose inputs a confirmed foreign tx spent can never be mined ──
/** A payment's output to someone else, its change (wallet basket 'default'), a Store memo, and an unrelated output. */
const PAY = { lockingScript: '76a914' + '11'.repeat(20) + '88ac', satoshis: 20_000 };
const CHANGE = { lockingScript: '76a914' + '22'.repeat(20) + '88ac', satoshis: 79_000, basket: 'default' };
const MEMO = { lockingScript: '006a0d' + '62'.repeat(13), satoshis: 0 };
const OTHER = '76a914' + '33'.repeat(20) + '88ac';

describe('conflicted payments (an input spent on chain by a different, confirmed tx)', () => {
  /** A world where conflict + detach are wired; `conclusive` lists the outpoints whose foreign spend counts. */
  function conflictWorld() {
    const w = world();
    const conclusive = new Set<string>();
    const detached: string[] = [];
    let detachFails = false;
    w.deps.conflict = async (o, by) => conclusive.has(`${o}>${by}`);
    w.deps.detachInput = async (t, o, by) => {
      if (detachFails) throw new Error('store busy');
      detached.push(`${t}:${o}>${by}`);
    };
    // The foreign spender pays someone else (not a copy of the payment): what `due` gives the action below.
    w.deps.spenderOutputs = async () => [{ lockingScript: OTHER, satoshis: 250_000 }];
    return {
      w,
      conclusive,
      detached,
      failDetach: () => {
        detachFails = true;
      },
    };
  }
  const due = async (w: ReturnType<typeof world>, a: NoSendAction) => {
    w.actions = [{ outputs: [PAY, CHANGE], ...a }];
    await expireOnce(w.deps);
    w.advance(DEFAULT_TTL_S);
  };

  test('3 inputs, one spent by a confirmed foreign tx, two unspent, the payment 404 everywhere → detached, then aborted', async () => {
    const { w, conclusive, detached } = conflictWorld();
    await due(w, act(A, [`${P}.0`, `${P}.1`, `${Q}.0`]));
    w.spends.set(`${P}.1`, X);
    conclusive.add(`${P}.1>${X}`);
    const r = await expireOnce(w.deps);
    expect(r.released).toEqual([A]);
    expect(w.aborted).toEqual([A]);
    // Detached BEFORE the abort, so the abort can't hand the spent coin back.
    expect(detached).toEqual([`${A}:${P}.1>${X}`]);
    expect(w.logs.some((l) => l.includes('cancelled (aborted)'))).toBe(true);
  });

  test('OLD BEHAVIOUR without a conflict check: kept for ever (input-spent-elsewhere)', async () => {
    const w = world();
    await due(w, act(A, [`${P}.0`, `${P}.1`, `${Q}.0`]));
    w.spends.set(`${P}.1`, X);
    for (let i = 0; i < 3; i++) {
      const r = await expireOnce(w.deps);
      expect(r.kept).toEqual([{ txid: A, reason: 'input-spent-elsewhere' }]);
      w.advance(DEFAULT_TTL_S);
    }
    expect(w.aborted).toEqual([]);
  });

  test('a spend that is not conclusive (mempool, one source) → kept, nothing detached or aborted', async () => {
    const { w, detached } = conflictWorld();
    await due(w, act(A, [`${P}.0`, `${P}.1`]));
    w.spends.set(`${P}.1`, X);
    const r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'input-spent-elsewhere' }]);
    expect(w.aborted).toEqual([]);
    expect(detached).toEqual([]);
  });

  test('CRITICAL: the payment itself is known (seen) → never aborted, handed to sendWith', async () => {
    const { w, conclusive, detached } = conflictWorld();
    await due(w, act(A, [`${P}.0`, `${P}.1`]));
    w.spends.set(`${P}.1`, X);
    conclusive.add(`${P}.1>${X}`);
    w.seen.add(A);
    const r = await expireOnce(w.deps);
    expect(w.aborted).toEqual([]);
    expect(detached).toEqual([]);
    expect(r.settled).toEqual([A]);
  });

  test('CRITICAL: the payment unclear on any retry (a 429, a timeout) → kept; released on a later run', async () => {
    const { w, conclusive, detached } = conflictWorld();
    await due(w, act(A, [`${P}.0`, `${P}.1`]));
    w.spends.set(`${P}.1`, X);
    conclusive.add(`${P}.1>${X}`);
    let calls = 0;
    const flaky = async (t: string): Promise<Sighting> =>
      t === A && ++calls === 2 ? 'unclear' : t === A ? 'missing' : 'seen';
    w.deps.lookups = [flaky];
    let r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'chain-has-it-or-unclear' }]);
    expect(w.aborted).toEqual([]);
    expect(detached).toEqual([]);
    r = await expireOnce(w.deps);
    expect(r.released).toEqual([A]);
  });

  test('another input unclear → kept; another input spent by the payment itself → settle', async () => {
    const { w, conclusive } = conflictWorld();
    await due(w, act(A, [`${P}.0`, `${P}.1`]));
    w.spends.set(`${P}.1`, X);
    conclusive.add(`${P}.1>${X}`);
    w.unclear.add(`${P}.0`);
    let r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'input-unclear' }]);
    w.unclear.clear();
    w.spends.set(`${P}.0`, A);
    r = await expireOnce(w.deps);
    expect(r.settled).toEqual([A]);
    expect(w.aborted).toEqual([]);
  });

  test('a spender that is one of our own unsent actions never counts as a conflict', async () => {
    const { w, conclusive } = conflictWorld();
    w.actions = [act(A, [`${P}.0`]), act(B, [`${Q}.0`])];
    await expireOnce(w.deps);
    w.advance(DEFAULT_TTL_S);
    w.spends.set(`${P}.0`, B);
    conclusive.add(`${P}.0>${B}`);
    const r = await expireOnce(w.deps);
    expect(r.kept).toContainEqual({ txid: A, reason: 'input-spent-elsewhere' });
    expect(w.aborted).not.toContain(A);
  });

  test('no detachInput wired, or detaching fails → kept, never aborted', async () => {
    const a = conflictWorld();
    a.w.deps.detachInput = undefined;
    await due(a.w, act(A, [`${P}.0`, `${P}.1`]));
    a.w.spends.set(`${P}.1`, X);
    a.conclusive.add(`${P}.1>${X}`);
    let r = await expireOnce(a.w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'input-spent-elsewhere' }]);
    expect(a.w.aborted).toEqual([]);

    const b = conflictWorld();
    b.failDetach();
    await due(b.w, act(A, [`${P}.0`, `${P}.1`]));
    b.w.spends.set(`${P}.1`, X);
    b.conclusive.add(`${P}.1>${X}`);
    r = await expireOnce(b.w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'abort-failed' }]);
    expect(b.w.aborted).toEqual([]);
  });

  test('the wallet answering aborted:false (it saw the tx on chain) is not a release', async () => {
    const { w, conclusive } = conflictWorld();
    w.deps.abort = async () => ({ aborted: false });
    await due(w, act(A, [`${P}.0`, `${P}.1`]));
    w.spends.set(`${P}.1`, X);
    conclusive.add(`${P}.1>${X}`);
    const r = await expireOnce(w.deps);
    expect(r.released).toEqual([]);
    expect(r.kept).toEqual([{ txid: A, reason: 'abort-failed' }]);
  });

  test('every input spent by a malleated copy of this very payment (same outputs) → kept, nothing detached', async () => {
    const { w, conclusive, detached } = conflictWorld();
    w.deps.spenderOutputs = async () => [PAY, CHANGE];
    await due(w, act(A, [`${P}.0`, `${P}.1`]));
    w.spends.set(`${P}.0`, X);
    w.spends.set(`${P}.1`, X);
    conclusive.add(`${P}.0>${X}`);
    conclusive.add(`${P}.1>${X}`);
    const r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'input-spent-elsewhere' }]);
    expect(w.aborted).toEqual([]);
    expect(detached).toEqual([]);
  });

  test('a single-input payment whose input another device spent: cancelled only if the spender is not a copy of it', async () => {
    // The two-device sim's shape: a 20k noSend from one 100k coin; the phone's 250k send spends that coin.
    const OURS = { lockingScript: '76a914' + '11'.repeat(20) + '88ac', satoshis: 20_000 };
    const one = (spender: { lockingScript: string; satoshis: number }[] | undefined | 'throw') => {
      const c = conflictWorld();
      c.w.deps.spenderOutputs = async () => {
        if (spender === 'throw') throw new Error('429');
        return spender;
      };
      return c;
    };
    const run = async (c: ReturnType<typeof conflictWorld>) => {
      await due(c.w, {
        ...act(A, [`${P}.0`]),
        outputs: [OURS, { lockingScript: '76a914' + '22'.repeat(20) + '88ac', satoshis: 79_000 }],
      });
      c.w.spends.set(`${P}.0`, X);
      c.conclusive.add(`${P}.0>${X}`);
      return expireOnce(c.w.deps);
    };
    // A different payment (the phone's send): cancelled, the coin detached.
    let c = one([{ lockingScript: '76a914' + '33'.repeat(20) + '88ac', satoshis: 250_000 }]);
    let r = await run(c);
    expect(r.released).toEqual([A]);
    expect(c.detached).toEqual([`${A}:${P}.0>${X}`]);
    // A spender paying all of our outputs (a malleated or re-signed copy?): kept.
    c = one([OURS, { lockingScript: '76a914' + '22'.repeat(20) + '88ac', satoshis: 79_000 }]);
    r = await run(c);
    expect(r.kept).toEqual([{ txid: A, reason: 'input-spent-elsewhere' }]);
    expect(c.w.aborted).toEqual([]);
    // The spender can't be read (404 / 429): kept.
    for (const x of [undefined, 'throw'] as const) {
      c = one(x);
      r = await run(c);
      expect(r.kept).toEqual([{ txid: A, reason: 'input-spent-elsewhere' }]);
      expect(c.detached).toEqual([]);
    }
    // Our own outputs unknown (no locking scripts listed), or none paying others: kept.
    c = one([{ lockingScript: 'aa', satoshis: 1 }]);
    await due(c.w, { ...act(A, [`${P}.0`]), outputs: [{ satoshis: 20_000 }] });
    c.w.spends.set(`${P}.0`, X);
    c.conclusive.add(`${P}.0>${X}`);
    r = await expireOnce(c.w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'input-spent-elsewhere' }]);
    c = one([{ lockingScript: 'aa', satoshis: 1 }]);
    await due(c.w, { ...act(A, [`${P}.0`]), outputs: [CHANGE, MEMO] });
    c.w.spends.set(`${P}.0`, X);
    c.conclusive.add(`${P}.0>${X}`);
    r = await expireOnce(c.w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'input-spent-elsewhere' }]);
  });

  // Review of e8f086f5 (probe cases): a spender that is this payment re-signed must never be taken for "someone else".
  describe('a re-signed copy of the payment is kept (it paid the recipient: cancelling it invites a double payment)', () => {
    const run = async (
      ins: string[],
      spends: Record<string, string>,
      spenderOuts: Record<string, { lockingScript: string; satoshis: number }[]>,
      outputs: NoSendAction['outputs'] = [PAY, MEMO, CHANGE],
    ) => {
      const c = conflictWorld();
      c.w.deps.spenderOutputs = async (t) => spenderOuts[t];
      await due(c.w, { ...act(A, ins), outputs });
      for (const [o, by] of Object.entries(spends)) {
        c.w.spends.set(o, by);
        c.conclusive.add(`${o}>${by}`);
      }
      const r = await expireOnce(c.w.deps);
      return { r, c };
    };
    test('same recipient, different change (a fee bump), memo dropped', async () => {
      const { r, c } = await run([`${P}.0`], { [`${P}.0`]: X }, { [X]: [PAY, { ...CHANGE, satoshis: 78_900 }] });
      expect(r.kept).toEqual([{ txid: A, reason: 'input-spent-elsewhere' }]);
      expect(c.w.aborted).toEqual([]);
    });
    test('reordered, with extra outputs', async () => {
      const { r } = await run(
        [`${P}.0`],
        { [`${P}.0`]: X },
        { [X]: [{ lockingScript: '6a', satoshis: 0 }, CHANGE, PAY] },
      );
      expect(r.kept).toEqual([{ txid: A, reason: 'input-spent-elsewhere' }]);
    });
    test('its outputs split across two spenders', async () => {
      const PAY2 = { lockingScript: '76a914' + '44'.repeat(20) + '88ac', satoshis: 5_000 };
      const { r } = await run(
        [`${P}.0`, `${Q}.0`],
        { [`${P}.0`]: X, [`${Q}.0`]: Y },
        { [X]: [PAY], [Y]: [PAY2, { lockingScript: OTHER, satoshis: 1 }] },
        [PAY, PAY2, CHANGE],
      );
      expect(r.kept).toEqual([{ txid: A, reason: 'input-spent-elsewhere' }]);
    });
    test('re-signed from a subset of its inputs plus other coins (one input still unspent here)', async () => {
      const { r, c } = await run(
        [`${P}.0`, `${Q}.1`],
        { [`${P}.0`]: X },
        { [X]: [PAY, { lockingScript: OTHER, satoshis: 9 }] },
      );
      expect(r.kept).toEqual([{ txid: A, reason: 'input-spent-elsewhere' }]);
      expect(c.detached).toEqual([]);
    });
    test('the same subset case, but the spender pays someone else: cancelled', async () => {
      const { r } = await run(
        [`${P}.0`, `${Q}.1`],
        { [`${P}.0`]: X },
        { [X]: [{ lockingScript: OTHER, satoshis: 9 }] },
      );
      expect(r.released).toEqual([A]);
    });
    test('no spenderOutputs wired: kept, even with a clean input', async () => {
      const c = conflictWorld();
      c.w.deps.spenderOutputs = undefined;
      await due(c.w, act(A, [`${P}.0`, `${Q}.1`]));
      c.w.spends.set(`${P}.0`, X);
      c.conclusive.add(`${P}.0>${X}`);
      const r = await expireOnce(c.w.deps);
      expect(r.kept).toEqual([{ txid: A, reason: 'input-spent-elsewhere' }]);
    });
  });

  test('abortRemarking: the abort and the re-mark run as one call; reaffirmSpent only if its re-mark failed', async () => {
    const calls: string[] = [];
    const c = conflictWorld();
    c.w.deps.abortRemarking = async (t, remark) => {
      calls.push(`abortRemarking ${t} ${remark.map(([o, by]) => `${o}>${by}`).join(',')}`);
      return { aborted: true, remarked: true };
    };
    c.w.deps.reaffirmSpent = async (o) => void calls.push(`reaffirm ${o}`);
    await due(c.w, act(A, [`${P}.0`, `${P}.1`]));
    c.w.spends.set(`${P}.1`, X);
    c.conclusive.add(`${P}.1>${X}`);
    let r = await expireOnce(c.w.deps);
    expect(r.released).toEqual([A]);
    expect(calls).toEqual([`abortRemarking ${A} ${P}.1>${X}`]);
    expect(c.w.aborted).toEqual([]); // deps.abort not used

    const d = conflictWorld();
    calls.length = 0;
    d.w.deps.abortRemarking = async () => ({ aborted: true, remarked: false });
    d.w.deps.reaffirmSpent = async (o) => void calls.push(`reaffirm ${o}`);
    await due(d.w, act(A, [`${P}.0`, `${P}.1`]));
    d.w.spends.set(`${P}.1`, X);
    d.conclusive.add(`${P}.1>${X}`);
    r = await expireOnce(d.w.deps);
    expect(r.released).toEqual([A]);
    expect(calls).toEqual([`reaffirm ${P}.1`]);

    const e = conflictWorld();
    e.w.deps.abortRemarking = async () => ({ aborted: false });
    await due(e.w, act(A, [`${P}.0`, `${P}.1`]));
    e.w.spends.set(`${P}.1`, X);
    e.conclusive.add(`${P}.1>${X}`);
    r = await expireOnce(e.w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'abort-failed' }]);
  });

  test('after the abort the detached coins are re-marked spent; a failed re-mark does not undo the release', async () => {
    const { w, conclusive } = conflictWorld();
    const order: string[] = [];
    const abort0 = w.deps.abort;
    w.deps.abort = async (t) => {
      order.push('abort');
      return abort0(t);
    };
    w.deps.reaffirmSpent = async (o, by) => {
      order.push(`reaffirm ${o}>${by}`);
      throw new Error('busy');
    };
    await due(w, act(A, [`${P}.0`, `${P}.1`]));
    w.spends.set(`${P}.1`, X);
    conclusive.add(`${P}.1>${X}`);
    const r = await expireOnce(w.deps);
    expect(r.released).toEqual([A]);
    // Retried three times, then left to the coin check (logged); the release stands.
    expect(order).toEqual(['abort', ...Array(3).fill(`reaffirm ${P}.1>${X}`)]);
    expect(w.logs.some((l) => l.includes('could not re-mark'))).toBe(true);
  });

  test('storage switching, or the active store changing between detach and abort → kept (storage-busy)', async () => {
    const a = conflictWorld();
    a.w.deps.storageGate = () => null;
    await due(a.w, act(A, [`${P}.0`, `${P}.1`]));
    a.w.spends.set(`${P}.1`, X);
    a.conclusive.add(`${P}.1>${X}`);
    let r = await expireOnce(a.w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'storage-busy' }]);
    expect(a.detached).toEqual([]);
    expect(a.w.aborted).toEqual([]);

    const b = conflictWorld();
    let reads = 0;
    b.w.deps.storageGate = () => (++reads === 1 ? 'device' : 'remote');
    await due(b.w, act(A, [`${P}.0`, `${P}.1`]));
    b.w.spends.set(`${P}.1`, X);
    b.conclusive.add(`${P}.1>${X}`);
    r = await expireOnce(b.w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'storage-busy' }]);
    expect(b.detached.length).toBe(1); // the detached coin stays unspendable: correct, the chain spent it
    expect(b.w.aborted).toEqual([]);
  });

  test('not due yet → nothing is asked of the chain or detached', async () => {
    const { w, conclusive, detached } = conflictWorld();
    w.actions = [act(A, [`${P}.0`, `${P}.1`])];
    w.spends.set(`${P}.1`, X);
    conclusive.add(`${P}.1>${X}`);
    const r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'not-due' }]);
    expect(detached).toEqual([]);
  });
});

describe('conflictCheck: the automatic coin check rule', () => {
  const O = `${P}.1`;
  const check = (ix: string | null | undefined | 'throw', woc: { txid: string; confirmed: boolean } | null | 'throw') =>
    conflictCheck({
      index: async () => {
        if (ix === 'throw') throw new Error('429');
        return [ix];
      },
      woc: async () => {
        if (woc === 'throw') throw new Error('timeout');
        return woc;
      },
    })(O, X);
  test('WhatsOnChain confirmed (index silent or agreeing) → conclusive', async () => {
    expect(await check(undefined, { txid: X, confirmed: true })).toBe(true);
    expect(await check(null, { txid: X, confirmed: true })).toBe(true);
    expect(await check('throw', { txid: X, confirmed: true })).toBe(true);
    expect(await check(X, { txid: X, confirmed: true })).toBe(true);
  });
  test('both sources name the same spender in the mempool → conclusive', async () => {
    expect(await check(X, { txid: X, confirmed: false })).toBe(true);
  });
  test('one source only, sources disagree, or a lookup fails → not conclusive', async () => {
    expect(await check(undefined, { txid: X, confirmed: false })).toBe(false);
    expect(await check(X, null)).toBe(false);
    expect(await check(X, 'throw')).toBe(false);
    expect(await check(B, { txid: X, confirmed: true })).toBe(false);
    expect(await check(X, { txid: B, confirmed: true })).toBe(false);
    expect(await check('throw', 'throw')).toBe(false);
  });
});

describe('storageDetachInput', () => {
  test("only rows the action holds, only while it is 'nosend', never on a store that isn't active", async () => {
    const updates: [number, unknown][] = [];
    const cleared: string[] = [];
    let status = 'nosend';
    let active = true;
    const sp = {
      findTransactions: async ({ partial }: { partial: { txid: string } }) =>
        partial.txid === A
          ? [{ transactionId: 446, status }]
          : partial.txid === X
            ? [{ transactionId: 500, status: 'completed' }]
            : [],
      findOutputs: async () => [
        { outputId: 1, spentBy: 446 },
        { outputId: 2, spentBy: 999 },
      ],
      updateOutput: async (id: number, patch: unknown) => {
        updates.push([id, patch]);
        return 1;
      },
    };
    const detach = storageDetachInput({
      isActive: () => active,
      userId: async () => 1,
      run: (fn) => fn(sp as never),
      recordCleared: async (o, by) => void cleared.push(`${o}>${by}`),
    });
    await detach(A, `${P}.1`, X);
    expect(updates).toEqual([[1, { spendable: false, spentBy: 500 }]]);
    expect(cleared).toEqual([`${P}_1>${X}`]);
    status = 'failed';
    await expect(detach(A, `${P}.1`, X)).rejects.toThrow(/failed/);
    status = 'nosend';
    active = false;
    await expect(detach(A, `${P}.1`, X)).rejects.toThrow(/active/);
    expect(updates.length).toBe(1);
  });
});

describe('storageReaffirmSpent', () => {
  test('only a row that is spendable with no spender is set unspendable again', async () => {
    const updates: [number, unknown][] = [];
    const sp = {
      findTransactions: async () => [],
      findOutputs: async () => [
        { outputId: 1, spendable: true, spentBy: null },
        { outputId: 2, spendable: false, spentBy: null },
        { outputId: 3, spendable: true, spentBy: 7 },
      ],
      updateOutput: async (id: number, patch: unknown) => {
        updates.push([id, patch]);
        return 1;
      },
    };
    const re = storageReaffirmSpent({ isActive: () => true, userId: async () => 1, run: (fn) => fn(sp as never) });
    await re(`${P}.1`, X);
    expect(updates).toEqual([[1, { spendable: false, spentBy: undefined }]]);
    await expect(
      storageReaffirmSpent({ isActive: () => false, userId: async () => 1, run: (fn) => fn(sp as never) })(`${P}.1`, X),
    ).rejects.toThrow(/active/);
  });
});

// ── 13 Nov 2026: Store payments the Store never heard of, by the wallet's own record (no outbox) ──
describe('Store payments released early (storeAsk)', () => {
  function storeWorld(words: StoreWord[], kind: StoreKind = 'mine') {
    const w = world();
    const asked: string[] = [];
    const locked: string[] = [];
    let i = 0;
    w.deps.storeKind = async () => kind;
    w.deps.storeAsk = async (a) => {
      asked.push(a.txid);
      return words[Math.min(i++, words.length - 1)];
    };
    w.deps.lock = async (t, fn) => {
      locked.push(t);
      return fn();
    };
    return { w, asked, locked };
  }

  test('outbox wiped: the Store never heard of it → released at the first run after STORE_MIN_AGE_S', async () => {
    const { w, locked } = storeWorld(['never-heard']);
    w.actions = [act(A, [`${P}.0`, `${Q}.0`])];
    let r = await expireOnce(w.deps); // first sight
    expect(r.kept).toEqual([{ txid: A, reason: 'not-due' }]);
    w.advance(STORE_MIN_AGE_S);
    r = await expireOnce(w.deps);
    expect(r.released).toEqual([A]);
    expect(w.aborted).toEqual([A]);
    expect(locked).toEqual([A]);
  });

  test('a 429 from the Store first → kept (store-unclear); released on the retry', async () => {
    const { w } = storeWorld(['unclear', 'never-heard']);
    w.actions = [act(A, [`${P}.0`])];
    await expireOnce(w.deps);
    w.advance(STORE_MIN_AGE_S);
    let r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'store-unclear' }]);
    expect(w.aborted).toEqual([]);
    w.advance(600);
    r = await expireOnce(w.deps);
    expect(r.released).toEqual([A]);
  });

  test('a 429 from the chain first → kept; released on the retry', async () => {
    const { w } = storeWorld(['never-heard']);
    w.actions = [act(A, [`${P}.0`])];
    await expireOnce(w.deps);
    w.advance(STORE_MIN_AGE_S);
    w.unclear.add(A);
    let r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'chain-has-it-or-unclear' }]);
    w.unclear.clear();
    r = await expireOnce(w.deps);
    expect(r.released).toEqual([A]);
  });

  test('CRITICAL: the Store heard of it → kept until the normal deadline; the chain having it → sendWith', async () => {
    const { w } = storeWorld(['heard']);
    w.actions = [act(A, [`${P}.0`])];
    await expireOnce(w.deps);
    w.advance(STORE_MIN_AGE_S);
    let r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'store-heard' }]);
    expect(w.aborted).toEqual([]);

    const s = storeWorld(['never-heard']);
    s.w.actions = [act(A, [`${P}.0`])];
    await expireOnce(s.w.deps);
    s.w.advance(STORE_MIN_AGE_S);
    s.w.seen.add(A);
    r = await expireOnce(s.w.deps);
    expect(r.settled).toEqual([A]);
    expect(s.w.aborted).toEqual([]);
  });

  test('CRITICAL: the Store hears of it between the first ask and the abort (a Pay) → kept, inside the lock', async () => {
    const { w, asked } = storeWorld(['never-heard', 'heard']);
    w.actions = [act(A, [`${P}.0`])];
    await expireOnce(w.deps);
    w.advance(STORE_MIN_AGE_S);
    const r = await expireOnce(w.deps);
    expect(asked).toEqual([A, A]);
    expect(r.kept).toEqual([{ txid: A, reason: 'store-heard' }]);
    expect(w.aborted).toEqual([]);
  });

  test("not a Store payment, too young, or a 'never' label → the normal deadline", async () => {
    const { w, asked } = storeWorld(['never-heard'], 'not-store');
    w.actions = [act(A, [`${P}.0`])];
    await expireOnce(w.deps);
    let r = await expireOnce(w.deps);
    expect(asked).toEqual([]);
    w.advance(STORE_MIN_AGE_S);
    r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'not-due' }]);
    expect(asked).toEqual([]); // not a Store payment: never asked
    const y = storeWorld(['never-heard']);
    y.w.actions = [act(A, [`${P}.0`])];
    await expireOnce(y.w.deps);
    y.w.advance(STORE_MIN_AGE_S - 1);
    await expireOnce(y.w.deps);
    expect(y.asked).toEqual([]); // too young: not even asked
    const n = storeWorld(['never-heard']);
    n.w.actions = [act(A, [`${P}.0`], ['p nosend expiry never'])];
    await expireOnce(n.w.deps);
    n.w.advance(STORE_MIN_AGE_S);
    r = await expireOnce(n.w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'never' }]);
    expect(n.asked).toEqual([]);
  });

  test('MEDIUM (cross-device): a Store payment made on ANOTHER device is never released early, nor at 24 h', async () => {
    const { w, asked } = storeWorld(['never-heard'], 'other-device');
    w.actions = [act(A, [`${P}.0`])];
    await expireOnce(w.deps);
    w.advance(STORE_MIN_AGE_S);
    let r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'not-due' }]);
    w.advance(DEFAULT_TTL_S); // past the usual 24 h: still held (the paying device may still Pay again)
    r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'not-due' }]);
    expect(asked).toEqual([]);
    expect(w.aborted).toEqual([]);
    w.advance(STORE_OTHER_DEVICE_TTL_S - DEFAULT_TTL_S - STORE_MIN_AGE_S);
    r = await expireOnce(w.deps);
    expect(r.released).toEqual([A]);
  });

  test("another device's Store payment past 24 h that can never be mined (input spent, confirmed) → cancelled", async () => {
    const { w } = storeWorld(['never-heard'], 'other-device');
    const detached: string[] = [];
    w.deps.conflict = async () => true;
    w.deps.detachInput = async (_t, o) => void detached.push(o);
    w.deps.spenderOutputs = async () => [{ lockingScript: OTHER, satoshis: 250_000 }];
    w.actions = [{ ...act(A, [`${P}.0`, `${Q}.0`]), outputs: [PAY, CHANGE] }];
    await expireOnce(w.deps);
    w.advance(DEFAULT_TTL_S);
    w.spends.set(`${P}.0`, X);
    const r = await expireOnce(w.deps);
    expect(r.released).toEqual([A]);
    expect(detached).toEqual([`${P}.0`]);
  });

  test('a storeKind that throws counts as another device (the longest hold)', async () => {
    const { w } = storeWorld(['never-heard']);
    w.deps.storeKind = async () => {
      throw new Error('storage');
    };
    w.actions = [act(A, [`${P}.0`])];
    await expireOnce(w.deps);
    w.advance(DEFAULT_TTL_S);
    const r = await expireOnce(w.deps);
    expect(r.kept).toEqual([{ txid: A, reason: 'not-due' }]);
  });
});
