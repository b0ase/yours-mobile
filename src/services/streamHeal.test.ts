import { describe, expect, test } from 'bun:test';
import { healStrandedStreamActions, isStrandedStream } from './streamHeal';

describe('release a broken streamed inscription', () => {
  test('only unbroadcast stream steps are released', () => {
    expect(isStrandedStream({ txid: 'a', status: 'nosend', description: 'Stream origin inscription' })).toBe(true);
    expect(isStrandedStream({ txid: 'a', status: 'unsigned', description: 'Stream chunk 3/12' })).toBe(true);
    expect(isStrandedStream({ txid: 'a', status: 'sending', description: 'Stream chunk 3/12' })).toBe(false);
    expect(isStrandedStream({ txid: 'a', status: 'nosend', description: 'Tip @aigf' })).toBe(false);
    expect(isStrandedStream({ status: 'nosend', description: 'Stream origin inscription' })).toBe(false);
    expect(isStrandedStream({ txid: 'a', status: 'nosend', description: 'Sigma anchor output' })).toBe(true);
    expect(isStrandedStream({ txid: 'a', status: 'completed', description: 'Sigma anchor output' })).toBe(false);
    expect(isStrandedStream({ txid: 'a', status: 'unsigned', description: 'Transfer ordinal' })).toBe(true);
    expect(isStrandedStream({ txid: 'a', status: 'nosend', description: 'Transfer 3 ordinals' })).toBe(true);
    expect(isStrandedStream({ txid: 'a', status: 'sending', description: 'Transfer ordinal' })).toBe(false);
  });

  test('aborts the stranded ones and reports errors without throwing', async () => {
    const aborted: string[] = [];
    const wallet = {
      listActions: async () => ({
        totalActions: 3,
        actions: [
          { txid: 't1', status: 'nosend', description: 'Stream origin inscription' },
          { txid: 't2', status: 'unsigned', description: 'Stream chunk 1/2' },
          { txid: 't3', status: 'completed', description: 'Stream chunk 2/2' },
        ],
      }),
      abortAction: async ({ reference }: { reference: string }) => {
        if (reference === 't2') throw new Error('nope');
        aborted.push(reference);
        return { aborted: true as const };
      },
    } as unknown as Parameters<typeof healStrandedStreamActions>[0];
    const r = await healStrandedStreamActions(wallet);
    expect(aborted).toEqual(['t1']);
    expect(r.aborted).toEqual(['t1']);
    expect(r.errors).toHaveLength(1);
  });
});
