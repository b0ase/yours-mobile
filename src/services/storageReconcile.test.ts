import { describe, expect, test } from 'bun:test';
import type { sdk } from '@bsv/wallet-toolbox-client';
import {
  advanceOffsets,
  type ChainAnswers,
  decideSpend,
  diffIndexes,
  emptyIndex,
  indexChunk,
  initialOffsets,
  isFinalChunk,
  matchesVerdict,
  type ReconcileRecord,
  reconcileOutcome,
  type StoreIndex,
  staleSpends,
  unspentCandidates,
  INTERRUPTED_RECONCILE_ERROR,
  MAX_RECONCILE_RESUMES,
  shouldResumeReconcile,
  mapPool,
  withRetry,
  isFullPass,
  needsVerifyReread,
} from './storageReconcile';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

const tx = (transactionId: number, txid: string, status: sdk.TransactionStatus = 'completed') =>
  ({ transactionId, txid, reference: `r${transactionId}`, status }) as sdk.TableTransaction;

const out = (outputId: number, transactionId: number, txid: string, vout: number, spentBy?: number) =>
  ({ outputId, transactionId, txid, vout, spendable: spentBy === undefined, spentBy }) as sdk.TableOutput;

const index = (chunk: Partial<sdk.SyncChunk>): StoreIndex => {
  const i = emptyIndex();
  indexChunk(i, chunk as sdk.SyncChunk);
  return i;
};

const chain = (spends: Record<string, string | null>, statuses: Record<string, 'mined' | 'known' | 'unknown'>) =>
  ({ spends: new Map(Object.entries(spends)), statuses: new Map(Object.entries(statuses)) }) as ChainAnswers;

describe('paging', () => {
  test('final only when every entity was reached and empty', () => {
    const empty = Object.fromEntries(
      [
        'provenTxs',
        'outputBaskets',
        'outputTags',
        'txLabels',
        'transactions',
        'outputs',
        'txLabelMaps',
        'outputTagMaps',
        'certificates',
        'certificateFields',
        'commissions',
        'provenTxReqs',
      ].map((k) => [k, []]),
    ) as unknown as sdk.SyncChunk;
    expect(isFinalChunk(empty)).toBe(true);
    expect(isFinalChunk({ ...empty, commissions: undefined })).toBe(false);
  });

  test('offsets advance per entity', () => {
    const offsets = initialOffsets();
    const n = advanceOffsets(offsets, {
      transactions: [tx(1, A), tx(2, B)],
      outputs: [out(1, 1, A, 0)],
    } as sdk.SyncChunk);
    expect(n).toBe(3);
    expect(offsets.find((o) => o.name === 'transaction')?.offset).toBe(2);
    expect(offsets.find((o) => o.name === 'output')?.offset).toBe(1);
  });
});

describe('diffIndexes', () => {
  test('finds records held by only one store, matching by txid across different ids', () => {
    const local = index({ transactions: [tx(1, A), tx(2, B)], outputs: [out(10, 1, A, 0)] });
    const remote = index({ transactions: [tx(7, A)], outputs: [out(70, 7, A, 0), out(71, 7, A, 1)] });
    const d = diffIndexes(local, remote);
    expect(d.onlyLocal.transactions).toEqual([B]);
    expect(d.onlyRemote.outputs).toEqual([`${A}.1`]);
    expect(d.spendConflicts).toEqual([]);
  });

  test('reports outputs spent by different transactions in each store', () => {
    const local = index({ transactions: [tx(1, A), tx(2, B)], outputs: [out(10, 1, A, 0, 2)] });
    const remote = index({ transactions: [tx(5, A), tx(6, C)], outputs: [out(50, 5, A, 0, 6)] });
    expect(diffIndexes(local, remote).spendConflicts).toEqual([
      { outpoint: `${A}.0`, txid: A, vout: 0, local: B, remote: C },
    ]);
  });

  test('reports a spend recorded on one side only', () => {
    const local = index({ transactions: [tx(1, A), tx(2, B)], outputs: [out(10, 1, A, 0, 2)] });
    const remote = index({ transactions: [tx(5, A)], outputs: [out(50, 5, A, 0)] });
    expect(diffIndexes(local, remote).spendConflicts[0]).toMatchObject({ local: B, remote: null });
  });
});

describe('decideSpend', () => {
  const local = index({ transactions: [tx(1, A), tx(2, B)], outputs: [out(10, 1, A, 0, 2)] });
  const remote = index({ transactions: [tx(5, A), tx(6, C)], outputs: [out(50, 5, A, 0, 6)] });
  const conflict = diffIndexes(local, remote).spendConflicts[0];

  test('indexer spend wins', () => {
    expect(decideSpend(conflict, local, remote, chain({ [`${A}.0`]: C }, {}))).toEqual({ kind: 'spent', txid: C });
  });

  test('single mined candidate wins when the indexer has no spend', () => {
    expect(decideSpend(conflict, local, remote, chain({}, { [B]: 'mined', [C]: 'unknown' }))).toEqual({
      kind: 'spent',
      txid: B,
    });
  });

  test('unmined candidates with a mined output leave it unspent', () => {
    expect(decideSpend(conflict, local, remote, chain({}, { [A]: 'mined', [B]: 'unknown', [C]: 'unknown' }))).toEqual({
      kind: 'unspent',
    });
  });

  test('a candidate seen on the network stays unresolved', () => {
    expect(decideSpend(conflict, local, remote, chain({}, { [A]: 'mined', [B]: 'known' })).kind).toBe('unresolved');
  });

  test('a pending wallet spend stays unresolved', () => {
    const pending = index({ transactions: [tx(1, A), tx(2, B, 'nosend')], outputs: [out(10, 1, A, 0, 2)] });
    const c = diffIndexes(pending, remote).spendConflicts[0];
    expect(decideSpend(c, pending, remote, chain({}, { [A]: 'mined' })).kind).toBe('unresolved');
  });

  test('an unconfirmed output stays unresolved', () => {
    expect(decideSpend(conflict, local, remote, chain({}, { [A]: 'unknown' })).kind).toBe('unresolved');
  });
});

describe('matchesVerdict', () => {
  const store = index({ transactions: [tx(1, A), tx(2, B)], outputs: [out(10, 1, A, 0, 2), out(11, 1, A, 1)] });

  test('spent by a stored transaction', () => {
    expect(matchesVerdict(store, `${A}.0`, { kind: 'spent', txid: B })).toBe(true);
    expect(matchesVerdict(store, `${A}.0`, { kind: 'spent', txid: C })).toBe(false);
  });

  test('unspent', () => {
    expect(matchesVerdict(store, `${A}.1`, { kind: 'unspent' })).toBe(true);
    expect(matchesVerdict(store, `${A}.0`, { kind: 'unspent' })).toBe(false);
  });
});

describe('reconcileOutcome', () => {
  const base: ReconcileRecord = {
    startedAt: '2026-10-02T00:00:00.000Z',
    trigger: 'migration',
    appVersion: '5.1.0',
    remoteUrl: 'https://wallet.1sat.app',
  };
  const finished = { ...base, finishedAt: '2026-10-02T00:01:00.000Z' };
  const verified = { onlyLocal: 0, onlyRemote: 0, mismatched: [] };

  test('running until finished', () => {
    expect(reconcileOutcome(base)).toBe('running');
  });

  test('failed when an error was recorded', () => {
    expect(reconcileOutcome({ ...finished, error: 'boom', verify: verified })).toBe('failed');
  });

  test('clean only when verified with nothing unresolved', () => {
    expect(reconcileOutcome({ ...finished, verify: verified, spendConflicts: [] })).toBe('clean');
    expect(reconcileOutcome({ ...finished, verify: { ...verified, onlyRemote: 1 } })).toBe('differences');
    expect(
      reconcileOutcome({
        ...finished,
        verify: verified,
        spendConflicts: [
          {
            outpoint: `${A}.0`,
            txid: A,
            vout: 0,
            local: B,
            remote: null,
            verdict: { kind: 'unresolved', reason: 'x' },
          },
        ],
      }),
    ).toBe('differences');
  });

  test('a finished run without a verify step is not clean', () => {
    expect(reconcileOutcome(finished)).toBe('differences');
  });
});

describe('stale unspent rescan', () => {
  test('candidates are outputs listed unspent, excluding conflicts and recorded spends', () => {
    const local = index({
      transactions: [tx(1, A), tx(2, B)],
      outputs: [out(1, 1, A, 0), out(2, 1, A, 1, 2), out(3, 2, B, 0)],
    });
    const remote = index({
      transactions: [tx(1, A), tx(3, C)],
      outputs: [out(1, 1, A, 0), out(2, 1, A, 1), out(4, 3, C, 0)],
    });
    const diff = diffIndexes(local, remote);
    expect(diff.spendConflicts.map((c) => c.outpoint)).toEqual([`${A}.1`]);
    expect(unspentCandidates(local, remote, diff.spendConflicts).sort()).toEqual([`${A}.0`, `${B}.0`, `${C}.0`].sort());
  });

  test('an output both stores agree is unspent is still a candidate', () => {
    const local = index({ transactions: [tx(1, A)], outputs: [out(1, 1, A, 0)] });
    const remote = index({ transactions: [tx(1, A)], outputs: [out(1, 1, A, 0)] });
    const diff = diffIndexes(local, remote);
    expect(diff.spendConflicts).toEqual([]);
    expect(unspentCandidates(local, remote, diff.spendConflicts)).toEqual([`${A}.0`]);
  });

  test('only a positive indexer spend marks an output stale', () => {
    const spends = new Map<string, string | null>([
      [`${A}.0`, B],
      [`${A}.1`, null],
    ]);
    expect(staleSpends([`${A}.0`, `${A}.1`, `${A}.2`], spends)).toEqual([
      { outpoint: `${A}.0`, txid: A, vout: 0, spentBy: B },
    ]);
  });

  test('a stale output marked spent matches the spent verdict even without the spender in the wallet', () => {
    const fixed = index({ transactions: [tx(1, A)], outputs: [{ ...out(1, 1, A, 0), spendable: false }] });
    expect(matchesVerdict(fixed, `${A}.0`, { kind: 'spent', txid: B })).toBe(true);
    const still = index({ transactions: [tx(1, A)], outputs: [out(1, 1, A, 0)] });
    expect(matchesVerdict(still, `${A}.0`, { kind: 'spent', txid: B })).toBe(false);
  });
});

describe('shouldResumeReconcile', () => {
  const base = {
    startedAt: '2026-10-06T00:55:59.022Z',
    finishedAt: '2026-10-07T03:40:32.374Z',
    trigger: 'migration' as const,
    appVersion: '5.1.65',
    remoteUrl: 'https://wallet.1sat.app',
  };

  test('resumes a run the worker stopped, even after its notice was dismissed', () => {
    expect(shouldResumeReconcile({ ...base, error: INTERRUPTED_RECONCILE_ERROR, acknowledged: true })).toBe(true);
  });

  test('stops resuming after the limit', () => {
    expect(
      shouldResumeReconcile({ ...base, error: INTERRUPTED_RECONCILE_ERROR, resumeAttempts: MAX_RECONCILE_RESUMES }),
    ).toBe(false);
  });

  test('leaves real failures, clean runs, running runs and no record alone', () => {
    expect(shouldResumeReconcile({ ...base, error: 'Remote storage is not connected' })).toBe(false);
    expect(shouldResumeReconcile(base)).toBe(false);
    expect(shouldResumeReconcile({ ...base, finishedAt: undefined, error: INTERRUPTED_RECONCILE_ERROR })).toBe(false);
    expect(shouldResumeReconcile(undefined)).toBe(false);
  });
});

describe('release a never-broadcast local send', () => {
  const remote = index({ transactions: [tx(5, A)], outputs: [out(50, 5, A, 0)] });
  const held = (status: sdk.TransactionStatus) =>
    index({ transactions: [tx(1, A), tx(2, B, status)], outputs: [out(10, 1, A, 0, 2)] });

  test('nosend/unsigned, only on this device, unknown on chain → release', () => {
    for (const status of ['nosend', 'unsigned'] as const) {
      const local = held(status);
      const c = diffIndexes(local, remote).spendConflicts[0];
      expect(decideSpend(c, local, remote, chain({}, { [A]: 'mined', [B]: 'unknown' }))).toEqual({
        kind: 'release',
        txid: B,
      });
    }
  });

  test('never released if the network may have it', () => {
    for (const status of ['sending', 'unprocessed', 'unproven', 'completed'] as const) {
      const local = held(status);
      const c = diffIndexes(local, remote).spendConflicts[0];
      expect(decideSpend(c, local, remote, chain({}, { [A]: 'mined', [B]: 'unknown' })).kind).not.toBe('release');
    }
    const local = held('nosend');
    const c = diffIndexes(local, remote).spendConflicts[0];
    expect(decideSpend(c, local, remote, chain({}, { [A]: 'mined', [B]: 'known' })).kind).not.toBe('release');
    expect(decideSpend(c, local, remote, chain({ [`${A}.0`]: C }, {})).kind).toBe('spent');
  });

  test('never released when the remote copy also has that transaction', () => {
    const local = held('nosend');
    const both = index({ transactions: [tx(5, A), tx(6, B, 'nosend')], outputs: [out(50, 5, A, 0)] });
    const c = diffIndexes(local, both).spendConflicts[0];
    expect(decideSpend(c, local, both, chain({}, { [A]: 'mined', [B]: 'unknown' })).kind).not.toBe('release');
  });

  test('a released output matches once it is spendable again', () => {
    const after = index({ transactions: [tx(1, A)], outputs: [out(10, 1, A, 0)] });
    expect(matchesVerdict(after, `${A}.0`, { kind: 'release', txid: B })).toBe(true);
    expect(matchesVerdict(held('nosend'), `${A}.0`, { kind: 'release', txid: B })).toBe(false);
  });
});

describe('mapPool / withRetry', () => {
  test('keeps order and never exceeds the limit', async () => {
    let live = 0;
    let peak = 0;
    const r = await mapPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((res) => setTimeout(res, 5));
      live--;
      return n * 2;
    });
    expect(r).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
  });

  test('retries 429s with backoff, not other errors', async () => {
    let calls = 0;
    const slept: number[] = [];
    const sleep = async (ms: number) => void slept.push(ms);
    const v = await withRetry(
      async () => {
        if (++calls < 3) throw new Error('HTTP 429 Too Many Requests');
        return 'ok';
      },
      { sleep, baseMs: 100 },
    );
    expect(v).toBe('ok');
    expect(slept).toEqual([100, 200]);
    await expect(
      withRetry(
        async () => {
          throw new Error('boom');
        },
        { sleep },
      ),
    ).rejects.toThrow('boom');
  });
});

describe('incremental repair', () => {
  test('manual runs push only changes; migration or an explicit full run resend all', () => {
    expect(isFullPass('manual')).toBe(false);
    expect(isFullPass('manual', { full: true })).toBe(true);
    expect(isFullPass('migration')).toBe(true);
  });
  test('verify re-reads only when something moved', () => {
    const none = { inserts: 0, updates: 0 };
    expect(needsVerifyReread({ pushed: [none, none], corrected: 0, oneSided: 0 })).toBe(false);
    expect(needsVerifyReread({ pushed: [{ inserts: 1, updates: 0 }, none], corrected: 0, oneSided: 0 })).toBe(true);
    expect(needsVerifyReread({ pushed: [none, none], corrected: 2, oneSided: 0 })).toBe(true);
    expect(needsVerifyReread({ pushed: [none, none], corrected: 0, oneSided: 3 })).toBe(true);
  });
});
