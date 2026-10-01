import { describe, expect, test } from 'bun:test';
import { INDEX_FUND_LABEL } from './indexFund';
import { classifyIndexFundAction, healIndexFundActions } from './indexFundHeal';

const L = [INDEX_FUND_LABEL];
const tx = (c: string) => c.repeat(64);

describe('classifyIndexFundAction', () => {
  test('aborts only never-broadcast actions of ours', () => {
    expect(classifyIndexFundAction({ status: 'nosend', labels: L })).toBe('abort');
    expect(classifyIndexFundAction({ status: 'unsigned', labels: L })).toBe('abort');
  });
  test('signed / possibly broadcast is never aborted', () => {
    expect(classifyIndexFundAction({ status: 'sending', labels: L })).toBe('pending');
    expect(classifyIndexFundAction({ status: 'unprocessed', labels: L })).toBe('pending');
    expect(classifyIndexFundAction({ status: 'unproven', labels: L })).toBe('done');
    expect(classifyIndexFundAction({ status: 'completed', labels: L })).toBe('done');
  });
  test('not ours → untouched', () => {
    expect(classifyIndexFundAction({ status: 'nosend', labels: ['other'] })).toBe('done');
    expect(classifyIndexFundAction({ status: 'nosend' })).toBe('done');
  });
});

describe('healIndexFundActions', () => {
  test('aborts nosend, reports sending, leaves the rest', async () => {
    const aborted: string[] = [];
    const wallet = {
      listActions: async () => ({
        totalActions: 3,
        actions: [
          { txid: tx('a'), status: 'nosend', labels: L },
          { txid: tx('b'), status: 'sending', labels: L },
          { txid: tx('c'), status: 'completed', labels: L },
        ],
      }),
      abortAction: async ({ reference }: { reference: string }) => (aborted.push(reference), { aborted: true }),
    };
    const r = await healIndexFundActions(wallet as never);
    expect(aborted).toEqual([tx('a')]);
    expect(r).toEqual({ aborted: [tx('a')], pending: [tx('b')], errors: [] });
  });
  test('a hung wallet cannot block it, and it never throws', async () => {
    const wallet = { listActions: () => new Promise(() => {}), abortAction: async () => ({ aborted: true }) };
    const r = await healIndexFundActions(wallet as never, { timeoutMs: 50 });
    expect(r.errors[0]).toMatch(/timed out/);
  });
  test('an abort refusal is recorded, not thrown', async () => {
    const wallet = {
      listActions: async () => ({ totalActions: 1, actions: [{ txid: tx('a'), status: 'nosend', labels: L }] }),
      abortAction: async () => {
        throw new Error('known on chain');
      },
    };
    const r = await healIndexFundActions(wallet as never);
    expect(r.aborted).toEqual([]);
    expect(r.errors[0]).toMatch(/known on chain/);
  });
});
