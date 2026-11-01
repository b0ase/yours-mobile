import { describe, expect, test } from 'bun:test';
import { AUTHSIG_MAINNET_RECORD } from './fixtures';
import { MAX_LOOKUP_ITEMS, cleanLookupItems, createProofLookup } from './lookup';
import type { KvEntry } from './verify';

const entry = (): KvEntry => ({ ...AUTHSIG_MAINNET_RECORD, protocolID: [1, 'authsig'] });

describe('cleanLookupItems', () => {
  test('keeps proof keys only, texts only for content-hash keys, no duplicates', () => {
    const h = 'a'.repeat(64);
    expect(
      cleanLookupItems([
        { key: 'x-post-1', text: 'ignored' },
        { key: h },
        { key: h, text: 'the text' },
        { key: 'evil' },
        null,
        { key: 5 },
      ]),
    ).toEqual([{ key: 'x-post-1' }, { key: h, text: 'the text' }]);
    expect(cleanLookupItems('nope')).toEqual([]);
  });
  test('caps one message', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ key: `x-post-${i + 1}` }));
    expect(cleanLookupItems(many)).toHaveLength(MAX_LOOKUP_ITEMS);
  });
});

describe('createProofLookup', () => {
  test('verifies entries, caches for two minutes, forget() and fresh refetch', async () => {
    let calls = 0;
    let t = 0;
    const l = createProofLookup({
      get: async () => {
        calls++;
        return [entry()];
      },
      now: () => t,
    });
    const r = await l.lookup([{ key: AUTHSIG_MAINNET_RECORD.key }]);
    expect(r[AUTHSIG_MAINNET_RECORD.key]).toHaveLength(1);
    await l.lookup([{ key: AUTHSIG_MAINNET_RECORD.key }]);
    expect(calls).toBe(1);
    t = 3 * 60_000;
    await l.lookup([{ key: AUTHSIG_MAINNET_RECORD.key }]);
    expect(calls).toBe(2);
    l.forget(AUTHSIG_MAINNET_RECORD.key);
    await l.lookup([{ key: AUTHSIG_MAINNET_RECORD.key }]);
    expect(calls).toBe(3);
    await l.lookup([{ key: AUTHSIG_MAINNET_RECORD.key }], true);
    expect(calls).toBe(4);
  });

  test('drops entries that fail verification or belong to another key', async () => {
    const bad = { ...entry(), controller: '02' + 'f'.repeat(64) };
    const other = { ...entry(), key: 'x-post-9' };
    const l = createProofLookup({ get: async () => [bad, other, entry()] });
    const r = await l.lookup([{ key: AUTHSIG_MAINNET_RECORD.key }]);
    expect(r[AUTHSIG_MAINNET_RECORD.key]).toHaveLength(1);
  });

  test('an overlay error gives an empty list, not a failure', async () => {
    const l = createProofLookup({
      get: async () => {
        throw new Error('down');
      },
    });
    expect(await l.lookup([{ key: 'x-post-1' }])).toEqual({ 'x-post-1': [] });
  });
});
