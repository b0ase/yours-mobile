import { describe, expect, test } from 'bun:test';
import { txidOf, unbroadcastTxids } from './unbroadcast';

describe('unbroadcastTxids', () => {
  test('collects only never-broadcast statuses', async () => {
    const wallet = {
      listActions: async () => ({
        totalActions: 5,
        actions: [
          { txid: 'a', status: 'nosend' },
          { txid: 'b', status: 'completed' },
          { txid: 'c', status: 'unsigned' },
          { txid: 'd', status: 'sending' },
          { txid: 'e', status: 'failed' },
        ],
      }),
    } as never;
    expect([...(await unbroadcastTxids(wallet))].sort()).toEqual(['a', 'c', 'e']);
  });
  test('txidOf handles both outpoint forms', () => {
    expect(txidOf('ab.0')).toBe('ab');
    expect(txidOf('ab_1')).toBe('ab');
  });
});
