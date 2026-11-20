import { afterEach, describe, expect, test } from 'bun:test';
import { truthLines, type BalanceTruth } from './balanceTruth';
import {
  boundCopyRequests,
  clearRestoreView,
  getRestoreView,
  noteRestoreProgress,
  restoreLines,
  rowsIn,
  setRestoreView,
} from './restoreProgress';
import { summarizeActive, switchToLocalVerified, type StoreSummary, type SwitchDeps } from './restoreFromRemote';

const usd = (n: number) => `$${((n * 50) / 100_000_000).toFixed(2)}`;
afterEach(() => clearRestoreView());

const REMOTE_SUMMARY: StoreSummary = { outputs: 4, spendableSats: 190_000, actions: 6 };
const EMPTY: StoreSummary = { outputs: 0, spendableSats: 0, actions: 0 };

/** A restore whose copy is slow: the test watches the card's lines (as the BALANCE_TRUTH answer builds them) meanwhile. */
function slowRestore(copyMs: number) {
  let active: 'remote' | 'local' = 'remote';
  let copied = false;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const deps: SwitchDeps = {
    remoteUrl: 'https://backup.test',
    activeRemoteUrl: () => (active === 'remote' ? 'https://backup.test' : undefined),
    setActiveStorage: async (t) => {
      if (t === 'local') {
        await sleep(copyMs);
        copied = true;
        active = 'local';
      } else active = 'remote';
    },
    summarize: async () => (copied ? REMOTE_SUMMARY : active === 'remote' ? REMOTE_SUMMARY : EMPTY),
    pullRemote: async () => undefined,
    onPreview: (r) =>
      setRestoreView({ phase: 'copying', arrivingSats: r.spendableSats, done: 0, total: r.outputs + r.actions }),
    onChecking: () => {
      const v = getRestoreView();
      if (v) setRestoreView({ ...v, phase: 'checking', done: v.total });
    },
    onFinished: () => clearRestoreView(),
  };
  return { deps, isCopied: () => copied };
}
const cardLines = () => {
  const t: BalanceTruth = { held: [], arrivingSats: 0, syncApplies: false, restore: getRestoreView() };
  return truthLines(t, usd, Date.now());
};

describe('restore: the backup total shows while the wallet copies itself', () => {
  test('the card shows the backup total within seconds, while the (slow) copy is still running', async () => {
    const { deps, isCopied } = slowRestore(400);
    const t0 = Date.now();
    const done = switchToLocalVerified(deps);
    await new Promise((r) => setTimeout(r, 50));
    expect(isCopied()).toBe(false);
    expect(Date.now() - t0).toBeLessThan(5_000);
    const lines = cardLines();
    expect(lines.find((l) => l.kind === 'arriving')?.text).toBe(
      'Arriving: $0.10 (moving your wallet to this device) '.trim(),
    );
    expect(lines.find((l) => l.kind === 'progress')?.text).toBe('Moving your wallet to this device: 0 of 10');
    const r = await done;
    expect(r.ok).toBe(true);
  });

  test('it is display only: no part of the restore result or the wallet summaries carries it as spendable', async () => {
    const { deps } = slowRestore(50);
    let sawWhileCopying: StoreSummary | undefined;
    const base = deps.setActiveStorage;
    deps.setActiveStorage = async (t) => {
      // The wallet's own read during the copy: the device holds nothing spendable yet.
      sawWhileCopying = await deps.summarize();
      await base(t);
    };
    deps.summarize = async () => EMPTY;
    const preview = getRestoreView;
    const p = switchToLocalVerified({
      ...deps,
      summarizeBackup: async () => REMOTE_SUMMARY,
      summarize: async () => EMPTY,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(preview()?.arrivingSats).toBe(190_000);
    expect(sawWhileCopying?.spendableSats ?? 0).toBe(0);
    await p;
  });

  test('balance reads complete during the copy, and the card then switches to the real balance', async () => {
    const { deps } = slowRestore(300);
    const done = switchToLocalVerified(deps);
    let reads = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 200) {
      await deps.summarize();
      reads++;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(reads).toBeGreaterThan(3);
    expect(cardLines().some((l) => l.kind === 'arriving')).toBe(true);
    await done;
    expect(getRestoreView()).toBeNull();
    expect(cardLines().some((l) => l.kind === 'arriving' || l.kind === 'progress')).toBe(false);
  });

  test('a failed restore also takes the line away', async () => {
    const { deps } = slowRestore(10);
    deps.setActiveStorage = async (t) => {
      if (t === 'local') throw new Error('boom');
    };
    const r = await switchToLocalVerified(deps);
    expect(r.ok).toBe(false);
    expect(getRestoreView()).toBeNull();
  });

  test('the checking phase says so', () => {
    setRestoreView({ phase: 'checking', arrivingSats: 100_000, done: 10, total: 10 });
    expect(restoreLines(getRestoreView(), usd).map((l) => l.text)).toEqual([
      'Arriving: $0.05 (moving your wallet to this device)',
      'Moving your wallet to this device: checking your coins',
    ]);
  });

  test('hidden balance leaves the amount out; progress stays', () => {
    setRestoreView({ phase: 'copying', arrivingSats: 100_000, done: 2, total: 9 });
    expect(restoreLines(getRestoreView(), usd, { hideAmounts: true }).map((l) => l.kind)).toEqual(['progress']);
  });

  test('progress never passes the total and never goes back', () => {
    setRestoreView({ phase: 'copying', arrivingSats: 1, done: 0, total: 10 });
    noteRestoreProgress(4);
    noteRestoreProgress(2);
    expect(getRestoreView()?.done).toBe(4);
    noteRestoreProgress(99);
    expect(getRestoreView()?.done).toBe(10);
    clearRestoreView();
    noteRestoreProgress(5);
    expect(getRestoreView()).toBeNull();
  });
});

describe('restore: the copy asks for short pieces', () => {
  test('pages are capped, each request has a deadline, and the method is put back', async () => {
    const seen: number[] = [];
    let hang = false;
    const store = {
      getSyncChunk: async (a: Record<string, unknown>) => {
        seen.push(Number(a.maxItems));
        if (hang) await new Promise(() => undefined);
        return { outputs: [1, 2], transactions: [1] };
      },
    };
    const orig = store.getSyncChunk;
    let rows = 0;
    const undo = boundCopyRequests(store, { maxItems: 100, callMs: 30, onRows: (n) => (rows += n) });
    await store.getSyncChunk({ maxItems: 1000 });
    expect(seen).toEqual([100]);
    expect(rows).toBe(3);
    hang = true;
    await expect(store.getSyncChunk({})).rejects.toThrow(/did not answer/);
    undo();
    expect(store.getSyncChunk).toBe(orig);
    expect(rowsIn(null)).toBe(0);
  });

  test("the backup's first read uses small pages and a deadline", async () => {
    const limits: number[] = [];
    const wallet = {
      listOutputs: async (a: { limit: number; offset: number }) => {
        limits.push(a.limit);
        const n = Math.min(a.limit, 7 - a.offset);
        return { totalOutputs: 7, outputs: Array.from({ length: n }, () => ({ satoshis: 10, spendable: true })) };
      },
      listActions: async () => ({ totalActions: 3 }),
    };
    expect(await summarizeActive(wallet, { pageSize: 3, callMs: 50 })).toMatchObject({
      outputs: 7,
      spendableSats: 70,
      actions: 3,
    });
    expect(limits).toEqual([3, 3, 3]);
    const hung = { listOutputs: () => new Promise<never>(() => undefined), listActions: wallet.listActions };
    await expect(summarizeActive(hung, { callMs: 20 })).rejects.toThrow(/did not answer/);
  });
});
