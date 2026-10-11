import { describe, expect, test } from 'bun:test';
import { knownOnChain, recoverMinedFailedActions, type FailedAction } from './recoverFailed';
import { healStrandedStreamActions } from './streamHeal';
import { prepareFunding, resetRecoverThrottle } from './fundingPrep';

const T1 = 'c13ecd5bd63283685c8c699305fc98c701cee539d13aa2cf0ff7f9413c08f955';
const T2 = 'a'.repeat(64);

function fakeStore(failed: FailedAction[], mined: string[]) {
  let list = [...failed];
  const calls = { unfail: 0, runs: 0 };
  return {
    calls,
    deps: {
      listFailed: async (unfail: boolean) => {
        if (unfail) calls.unfail++;
        return list;
      },
      isMined: async (txid: string) => mined.includes(txid),
      runUnFail: async () => {
        calls.runs++;
        list = list.filter((a) => !mined.includes(a.txid));
        return 'ok';
      },
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
      isMined: async () => true,
      runUnFail: async () => '',
      log: () => undefined,
    });
    expect(r.error).toBe('db');
  });
});

describe('never abort what the network already has', () => {
  test('knownOnChain', async () => {
    expect(await knownOnChain(T1, async () => ({ rawTx: [1] }))).toBe(true);
    expect(await knownOnChain(T1, async () => '0100')).toBe(true);
    expect(await knownOnChain(T1, async () => ({ rawTx: undefined }))).toBe(false);
    expect(await knownOnChain(T1, async () => undefined)).toBe(false);
    expect(await knownOnChain('not-a-txid', async () => ({ rawTx: [1] }))).toBe(false);
    expect(
      await knownOnChain(T1, async () => {
        throw new Error('offline');
      }),
    ).toBe(false);
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
