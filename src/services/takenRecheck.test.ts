import { describe, expect, test } from 'bun:test';
import type { WocAnswer } from './autoCoinResync';
import { RECHECK_GAP_MS, RECHECK_MAX, RECHECK_WOC_PER_RUN, createTakenRecheck } from './takenRecheck';

const T = (n: number) => n.toString(16).padStart(64, '0');
const X = 'ab'.repeat(32); // the other copy's sweep
const OURS = 'cd'.repeat(32); // one of this wallet's own unfinished actions (failed, unsigned, nosend…)
const P = `${T(1)}.0`;

/** One device: what each source says per outpoint, and what was marked or put back. */
const harness = (o: { index?: Record<string, string | null>; woc?: Record<string, WocAnswer | 'throw'> } = {}) => {
  const clock = { t: 1_000_000 };
  const index = new Map(Object.entries(o.index ?? {}));
  const woc = new Map(Object.entries(o.woc ?? {}));
  const calls = { index: 0, woc: 0 };
  const marked: [string, string][] = [];
  const restored: string[] = [];
  const pulls: string[][] = [];
  const r = createTakenRecheck({
    index: async (b) => {
      calls.index++;
      return b.map((k) => index.get(k.replace('_', '.')) ?? null);
    },
    woc: async (k) => {
      calls.woc++;
      const w = woc.get(k.replace('_', '.'));
      if (w === 'throw') throw new Error('woc 503');
      return w ?? null;
    },
    ownPendingTxids: async () => new Set([OURS]),
    heldTxids: async () => new Set(),
    markSpent: async (op, by) => (marked.push([op, by]), 1),
    markUnspent: async (op) => (restored.push(op), 1),
    askPull: (s) => (pulls.push(s), true),
    now: () => clock.t,
  });
  return { r, clock, index, woc, calls, marked, restored, pulls };
};

describe('takenRecheck uses the automatic coin check’s rule (review 20, second re-check: Q1)', () => {
  test('both sources name the same spender (mempool is fine): marked spent, a pull asked', async () => {
    const h = harness({ index: { [P]: X }, woc: { [P]: { txid: X, confirmed: false } } });
    h.r.add([P]);
    await h.r.run({ force: true });
    expect(h.marked).toEqual([[P, X]]);
    expect(h.pulls).toEqual([[X]]);
  });

  test('Q1a: the index says unspent and WhatsOnChain names a mempool spend: one source, not marked', async () => {
    const h = harness({ index: { [P]: null }, woc: { [P]: { txid: X, confirmed: false } } });
    h.r.add([P]);
    await h.r.run({ force: true });
    expect(h.marked).toEqual([]);
  });

  test('the index names a spender WhatsOnChain does not see, or can’t answer for: not marked', async () => {
    for (const w of [null, 'throw'] as const) {
      const h = harness({ index: { [P]: X }, woc: { [P]: w as never } });
      h.r.add([P]);
      await h.r.run({ force: true });
      expect(h.marked).toEqual([]);
    }
  });

  test('the sources disagree on the spender: not marked', async () => {
    const h = harness({ index: { [P]: X }, woc: { [P]: { txid: 'ef'.repeat(32), confirmed: false } } });
    h.r.add([P]);
    await h.r.run({ force: true });
    expect(h.marked).toEqual([]);
  });

  test('Q1b: both name one of this wallet’s own unfinished actions (failed, unsigned, nosend…): never a spender', async () => {
    const h = harness({ index: { [P]: OURS }, woc: { [P]: { txid: OURS, confirmed: false } } });
    h.r.add([P]);
    await h.r.run({ force: true });
    expect(h.marked).toEqual([]);
    expect(h.pulls).toEqual([]);
  });

  test('the undo: a spender later dropped (WhatsOnChain no longer has it) puts the coin back, even if the index still names it', async () => {
    const h = harness({ index: { [P]: X }, woc: { [P]: { txid: X, confirmed: false } } });
    h.r.add([P]);
    await h.r.run({ force: true });
    expect(h.marked.length).toBe(1);
    h.woc.set(P, null as never); // dropped from the mempool; the index keeps its stale answer
    h.clock.t += RECHECK_GAP_MS;
    await h.r.run();
    expect(h.restored).toEqual([]); // once could be a lag: asked again
    h.clock.t += RECHECK_GAP_MS;
    await h.r.run();
    expect(h.restored).toEqual([P]);
  });

  test('a confirmed spend is final: never put back', async () => {
    const h = harness({ index: { [P]: X }, woc: { [P]: { txid: X, confirmed: true } } });
    h.r.add([P]);
    await h.r.run({ force: true });
    h.woc.set(P, null as never);
    for (let i = 0; i < 4; i++) {
      h.clock.t += RECHECK_GAP_MS;
      await h.r.run();
    }
    expect(h.restored).toEqual([]);
  });

  test('R2: after a restore, the index is asked in batches; WhatsOnChain only to confirm what it names, a few per run; the list is bounded', async () => {
    const h = harness();
    const ops = Array.from({ length: RECHECK_MAX + 50 }, (_, i) => `${T(i + 10)}.0`);
    for (const o of ops.slice(0, 30)) h.index.set(o, X);
    h.r.add(ops);
    expect(h.r.size()).toBe(RECHECK_MAX);
    await h.r.run({ force: true });
    expect(h.calls.index).toBe(Math.ceil(RECHECK_MAX / 100));
    expect(h.calls.woc).toBeLessThanOrEqual(RECHECK_WOC_PER_RUN);
  });
});
