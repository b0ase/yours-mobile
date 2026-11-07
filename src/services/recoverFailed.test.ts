import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { knownOnChain, recoverMinedFailedActions, recoverySummary, type FailedAction } from './recoverFailed';
import { healStrandedStreamActions } from './streamHeal';
import { prepareFunding, resetRecoverThrottle } from './fundingPrep';

const T1 = 'c13ecd5bd63283685c8c699305fc98c701cee539d13aa2cf0ff7f9413c08f955';
const T2 = 'a'.repeat(64);

function fakeStore(failed: FailedAction[], mined: string[]) {
  let list = [...failed];
  const calls = { unfail: 0, runs: 0, queued: [] as string[] };
  return {
    calls,
    deps: {
      listFailed: async () => list,
      queueUnfail: async (txids: string[]) => {
        calls.unfail++;
        calls.queued.push(...txids);
        return txids.length;
      },
      isMined: async (txid: string) => mined.includes(txid),
      runUnFail: async () => {
        calls.runs++;
        list = list.filter((a) => !mined.includes(a.txid));
        return 'ok';
      },
      spendableOf: async (txid: string) =>
        mined.includes(txid)
          ? { status: 'unproven', outputs: 2, spendable: 2, spendableSats: 25_432_286 }
          : { status: 'failed', outputs: 2, spendable: 0, spendableSats: 0 },
      log: () => undefined,
    },
  };
}

describe('restore failed actions that are mined', () => {
  test('a mined failed change transaction is restored and reported', async () => {
    const s = fakeStore([{ txid: T1, outputs: [{ satoshis: 25_000_000 }, { satoshis: 432_286 }] }, { txid: T2 }], [T1]);
    const r = await recoverMinedFailedActions(s.deps);
    expect(r.mined).toEqual([T1]);
    expect(r.restored).toEqual([T1]);
    expect(s.calls.unfail).toBe(1);
    expect(s.calls.queued).toEqual([T1]); // only the mined one, never every failed action
    expect(s.calls.runs).toBe(1);
  });

  test('nothing mined: no unfail queued, nothing run', async () => {
    const s = fakeStore([{ txid: T2 }], []);
    const r = await recoverMinedFailedActions(s.deps);
    expect(r.restored).toEqual([]);
    expect(s.calls.unfail).toBe(0);
    expect(s.calls.runs).toBe(0);
  });

  test('a proof the monitor rejects is not reported as restored', async () => {
    const s = fakeStore([{ txid: T1 }], [T1]);
    s.deps.runUnFail = async () => 'rejected';
    const r = await recoverMinedFailedActions(s.deps);
    expect(r.mined).toEqual([T1]);
    expect(r.restored).toEqual([]);
  });

  test('errors never throw', async () => {
    const r = await recoverMinedFailedActions({
      listFailed: async () => {
        throw new Error('db');
      },
      queueUnfail: async () => 0,
      isMined: async () => true,
      runUnFail: async () => '',
      log: () => undefined,
    });
    expect(r.error).toBe('db');
  });
});

describe('restored means spendable, read back (dkg, 14 Oct 2026)', () => {
  test('status repaired but outputs still unspendable: reported NOT restored, with the true state', async () => {
    const s = fakeStore([{ txid: T1 }], [T1]);
    s.deps.spendableOf = async () => ({ status: 'unproven', outputs: 8, spendable: 0, spendableSats: 0 });
    const r = await recoverMinedFailedActions(s.deps);
    expect(r.restored).toEqual([]);
    expect(r.notRestored?.[0].reason).toMatch(/0 of 8 outputs spendable/);
    expect(recoverySummary(r)).toMatch(/on chain but not restored/);
  });

  test('without a read-back nothing is claimed restored', async () => {
    const s = fakeStore([{ txid: T1 }], [T1]);
    const { spendableOf: _drop, ...deps } = s.deps;
    void _drop;
    const r = await recoverMinedFailedActions(deps);
    expect(r.restored).toEqual([]);
    expect(r.notRestored?.[0].reason).toMatch(/not verified/);
  });

  test('stuck unprocessed / sending / unsigned are candidates; only mined ones are queued', async () => {
    const s = fakeStore(
      [
        {
          txid: T1,
          status: 'unprocessed',
          description: 'Sweep 9 legacy BSV UTXOs',
          createdAt: Date.UTC(2026, 9, 14, 5, 56),
        },
        { txid: T2, status: 'sending' },
      ],
      [T1],
    );
    s.deps.spendableOf = async (t: string) =>
      t === T1
        ? { status: 'unproven', outputs: 1, spendable: 1, spendableSats: 58_614_198_569 }
        : { status: 'sending', outputs: 1, spendable: 0, spendableSats: 0 };
    const r = await recoverMinedFailedActions(s.deps);
    expect(s.calls.queued).toEqual([T1]);
    expect(r.restored).toEqual([T1]);
    expect(r.restoredDetail?.[0]).toMatchObject({ fromStatus: 'unprocessed', sats: 58_614_198_569 });
    expect(recoverySummary(r)).toMatch(/^Found 586\.14 BSV from \d\d:\d\d sweep; restored$/);
  });

  test('nothing stuck: "Nothing to restore"', async () => {
    const r = await recoverMinedFailedActions(fakeStore([], []).deps);
    expect(recoverySummary(r)).toBe('Nothing to restore');
  });

  test('a mempool-only (unmined) action is left alone', async () => {
    const s = fakeStore([{ txid: T1, status: 'sending' }], []);
    const r = await recoverMinedFailedActions(s.deps);
    expect(s.calls.unfail).toBe(0);
    expect(r.restored).toEqual([]);
  });
});

describe('never abort what the network already has', () => {
  test('knownOnChain asks the chain: "not found" everywhere is not known; anything else is (fails closed)', async () => {
    const say = (...answers: ('seen' | 'missing' | 'unclear')[]) => answers.map((a) => async () => a);
    expect(await knownOnChain(T1, say('missing', 'missing'))).toBe(false);
    expect(await knownOnChain(T1, say('missing', 'seen'))).toBe(true);
    expect(await knownOnChain(T1, say('seen', 'missing'))).toBe(true);
    // ARC holding it (QUEUED / ANNOUNCED) or any error is unclear: never abort on doubt.
    expect(await knownOnChain(T1, say('missing', 'unclear'))).toBe(true);
    expect(
      await knownOnChain(T1, [
        async () => 'missing',
        async () => {
          throw new Error('offline');
        },
      ]),
    ).toBe(true);
    expect(await knownOnChain('not-a-txid', say('seen'))).toBe(false);
    expect(await knownOnChain(T1, [])).toBe(true);
  });

  test("knownOnChain never reads the wallet's own copy or 1Sat's BEEF store (P0, 3 Nov 2026)", () => {
    const src = readFileSync('src/services/recoverFailed.ts', 'utf8');
    const fn = src.slice(src.indexOf('export async function knownOnChain'));
    expect(fn.slice(0, 300)).not.toMatch(/getRawTx|oneSat/);
    const init = readFileSync('src/initWallet.ts', 'utf8');
    expect(init).not.toContain('knownOnChain(txid, (t) => toolboxServices.getRawTx(t))');
  });

  test('stream heal skips a step already on chain', async () => {
    const aborted: string[] = [];
    const r = await healStrandedStreamActions(
      {
        listActions: async () => ({
          totalActions: 1,
          actions: [{ txid: T1, status: 'nosend', description: 'Stream chunk 2/5' }],
        }),
        abortAction: async ({ reference }: { reference: string }) => {
          aborted.push(reference);
          return { aborted: true };
        },
      } as never,
      { isKnown: async () => true },
    );
    expect(aborted).toEqual([]);
    expect(r.aborted).toEqual([]);
  });
});

describe('funding preparation restores when nothing is spendable', () => {
  test('recoverFailed runs once when spendable is 0', async () => {
    resetRecoverThrottle();
    let runs = 0;
    const wallet = {
      balance: async () => 0,
      listOutputs: async () => ({ totalOutputs: 0, outputs: [] }),
    };
    await prepareFunding({
      wallet: wallet as never,
      sweep: async () => ({ swept: 0 }),
      arriving: () => 0,
      recoverFailed: async () => {
        runs++;
        return { restored: [] };
      },
      log: () => undefined,
    });
    await prepareFunding({
      wallet: wallet as never,
      sweep: async () => ({ swept: 0 }),
      arriving: () => 0,
      recoverFailed: async () => {
        runs++;
        return { restored: [] };
      },
      log: () => undefined,
    });
    expect(runs).toBe(1);
  });
});

describe('recoverMinedFailedActions with a remote active store', () => {
  test('skips cleanly (no error, nothing queued) instead of throwing', async () => {
    const s = fakeStore([{ txid: T1, outputs: [{ satoshis: 1 }] }], [T1]);
    const r = await recoverMinedFailedActions({ ...s.deps, available: () => false, log: () => {} });
    expect(r.error).toBeUndefined();
    expect(r.skipped).toBeTruthy();
    expect(r.restored).toEqual([]);
    expect(s.calls.runs).toBe(0);
  });
});
