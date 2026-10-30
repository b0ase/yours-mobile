import { describe, expect, it } from 'bun:test';
import { isTruthyRequiredError, repairNullTxids, STALE_MS, type RepairTx } from './nullTxidRepair';

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
