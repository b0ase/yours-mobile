import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { reconcilePostage, resetPostageReconcileLimit, wocIsMined, type StuckPostage } from './postageReconcile';

const A = 'e195188ca09f93abed19ce891092d61382b5b53986b5f09f3b0c3c9b55964693';
const B = '059354fec17c6d4b8d16c06df6705748c7ebcb89d611e60c43843e32117f861d';
const rows: StuckPostage[] = [
  { transactionId: 1, txid: A, status: 'nosend' },
  { transactionId: 2, txid: B, status: 'unsent' },
];

describe('reconcilePostage', () => {
  beforeEach(() => resetPostageReconcileLimit());

  it('settles mined rows and leaves unmined ones alone', async () => {
    const settle = mock(async () => ({ outputs: 1 }));
    const r = await reconcilePostage({
      listStuck: async () => rows,
      isMined: async (t) => t === A,
      settle,
      log: () => undefined,
    });
    expect(r.settled).toEqual([A]);
    expect(r.pending).toEqual([B]);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith(rows[0]);
  });

  it('does not settle when the chain gives no answer', async () => {
    const settle = mock(async () => ({ outputs: 1 }));
    const r = await reconcilePostage({ listStuck: async () => rows, isMined: async () => undefined, settle });
    expect(settle).not.toHaveBeenCalled();
    expect(r.pending).toHaveLength(2);
  });

  it('records a failed repair and carries on', async () => {
    const r = await reconcilePostage({
      listStuck: async () => rows,
      isMined: async () => true,
      settle: async (row) => {
        if (row.txid === A) throw new Error('no proof');
        return { outputs: 1 };
      },
      log: () => undefined,
    });
    expect(r.errors).toEqual([{ txid: A, error: 'no proof' }]);
    expect(r.settled).toEqual([B]);
  });

  it('is rate-limited unless forced', async () => {
    const deps = { listStuck: async () => [], isMined: async () => true, settle: async () => ({ outputs: 0 }) };
    await reconcilePostage(deps, { now: 1_000_000 });
    expect((await reconcilePostage(deps, { now: 1_060_000 })).skipped).toBe('rate-limited');
    expect((await reconcilePostage(deps, { now: 1_060_000, force: true })).skipped).toBeUndefined();
    expect((await reconcilePostage(deps, { now: 1_000_000 + 6 * 60_000 })).skipped).toBeUndefined();
  });
});

describe('wocIsMined', () => {
  const res = (status: number, body?: unknown) =>
    ({ status, ok: status < 300, json: async () => body }) as unknown as Response;
  it('reads block height / 404 / errors', async () => {
    expect(await wocIsMined(A, async () => res(200, { blockheight: 971585, confirmations: 3 }))).toBe(true);
    expect(await wocIsMined(A, async () => res(200, { confirmations: 0 }))).toBe(false);
    expect(await wocIsMined(A, async () => res(404))).toBe(false);
    expect(await wocIsMined(A, async () => res(500))).toBeUndefined();
    expect(
      await wocIsMined(A, async () => {
        throw new Error('offline');
      }),
    ).toBeUndefined();
  });
});
