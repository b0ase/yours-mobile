import { describe, expect, it } from 'bun:test';
import {
  isTruthyRequiredError,
  MISSING_SPAN_MS,
  repairNullTxids,
  STALE_MS,
  type MissingLog,
  type RepairTx,
} from './nullTxidRepair';

const T = 'a'.repeat(64);
const U = 'b'.repeat(64);

describe('repairNullTxids', () => {
  it('fills txid from its transaction, sets aside outputs with none, aborts stale unsigned actions', async () => {
    const updates: [number, object][] = [];
    const aborted: string[] = [];
    const txs: Record<number, RepairTx> = {
      1: { transactionId: 1, txid: T, status: 'completed', reference: 'r1' },
      2: { transactionId: 2, txid: null, status: 'unsigned', reference: 'r2' },
    };
    const now = 1_000_000_000;
    const r = await repairNullTxids({
      spendableOutputs: async () => [
        { outputId: 10, transactionId: 1, txid: null, spendable: true },
        { outputId: 11, transactionId: 2, txid: null, spendable: true },
        { outputId: 12, transactionId: 1, txid: T, spendable: true },
      ],
      transaction: async (id) => txs[id],
      pendingActions: async () => [
        { ...txs[2], updated_at: new Date(now - STALE_MS - 1) },
        { transactionId: 3, txid: U, status: 'unprocessed', reference: 'r3', updated_at: new Date(0) },
        { transactionId: 4, txid: null, status: 'unsigned', reference: 'r4', updated_at: new Date(now - 1000) },
      ],
      updateOutput: async (id, p) => void updates.push([id, p]),
      abortAction: async (ref) => void aborted.push(ref),
      knownOnChain: async (txid) => txid === U,
      now: () => now,
    });
    expect(updates).toEqual([
      [10, { txid: T }],
      [11, { spendable: false }],
    ]);
    expect(aborted).toEqual(['r2']); // r3 is on chain, r4 is fresh
    expect(r).toEqual({ txidFilled: 1, setAside: 1, aborted: 1, skipped: 2 });
  });

  it('a chain lookup failure never aborts (fail closed)', async () => {
    const aborted: string[] = [];
    await repairNullTxids({
      spendableOutputs: async () => [],
      transaction: async () => undefined,
      pendingActions: async () => [{ transactionId: 1, txid: T, status: 'unprocessed', reference: 'r' }],
      updateOutput: async () => undefined,
      abortAction: async (ref) => void aborted.push(ref),
      knownOnChain: async () => {
        throw new Error('offline');
      },
    });
    expect(aborted).toEqual([]);
  });

  it('recognises the toolbox error', () => {
    expect(isTruthyRequiredError(new Error('A truthy value is required.'))).toBe(true);
    expect(isTruthyRequiredError(new Error('Insufficient funds'))).toBe(false);
  });
});

describe('action batch reservations', () => {
  it('releases a reservation held on an output with no txid and retries on the batch error', async () => {
    const released: number[] = [];
    const r = await repairNullTxids({
      spendableOutputs: async () => [{ outputId: 7, transactionId: 9, txid: null, spendable: true }],
      transaction: async () => undefined,
      pendingActions: async () => [],
      updateOutput: async () => undefined,
      abortAction: async () => undefined,
      releaseReservation: async (id) => (released.push(id), true),
      knownOnChain: async () => false,
    });
    expect(released).toEqual([7]);
    expect(r.reservationsReleased).toBe(1);
    expect(r.setAside).toBe(1);
    expect(isTruthyRequiredError(new Error('action batch output is missing its txid'))).toBe(true);
  });
});

describe('review 4 Nov 2026 F5: a signed action is aborted only after repeated "not found" answers over time', () => {
  const memLog = (): MissingLog & { m: Record<string, number[]> } => {
    const box = { m: {} as Record<string, number[]> };
    return Object.assign(box, {
      load: async () => ({ ...box.m }),
      save: async (x: Record<string, number[]>) => void (box.m = x),
    });
  };
  const run = (log: MissingLog | undefined, now: number, known: boolean, aborted: string[]) =>
    repairNullTxids({
      spendableOutputs: async () => [],
      transaction: async () => undefined,
      pendingActions: async () => [
        { transactionId: 1, txid: T, status: 'unprocessed', reference: 'r', updated_at: new Date(0) },
      ],
      updateOutput: async () => undefined,
      abortAction: async (ref) => void aborted.push(ref),
      knownOnChain: async () => known,
      missingLog: log,
      now: () => now,
    });

  it('one WhatsOnChain 404 + ARC 404 is not enough: 3 answers spread over 30+ minutes are', async () => {
    const log = memLog();
    const aborted: string[] = [];
    const t0 = 1_900_000_000_000;
    await run(log, t0, false, aborted);
    await run(log, t0 + 10 * 60_000, false, aborted);
    await run(log, t0 + 20 * 60_000, false, aborted);
    expect(aborted).toEqual([]); // three checks, but only 20 minutes apart
    await run(log, t0 + MISSING_SPAN_MS + 1, false, aborted);
    expect(aborted).toEqual(['r']);
  });

  it('any "may have it" answer in between starts the count again', async () => {
    const log = memLog();
    const aborted: string[] = [];
    const t0 = 1_900_000_000_000;
    await run(log, t0, false, aborted);
    await run(log, t0 + 15 * 60_000, true, aborted); // the network showed it (5916dd14 took 16 minutes)
    await run(log, t0 + 31 * 60_000, false, aborted);
    await run(log, t0 + 40 * 60_000, false, aborted);
    expect(aborted).toEqual([]);
  });

  it('without a place to keep the answers, a signed action is never aborted', async () => {
    const aborted: string[] = [];
    for (let i = 0; i < 5; i++) await run(undefined, 1_900_000_000_000 + i * 3_600_000, false, aborted);
    expect(aborted).toEqual([]);
  });
});
