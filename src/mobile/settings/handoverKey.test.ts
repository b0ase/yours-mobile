import { describe, expect, test } from 'bun:test';
import { handoverKey } from './handoverKey';

/** b-Aware opns-indexer, round 3: a $name is never handed to an OpNS key that only the index vouches for. */
describe('handoverKey: who a name is handed to', () => {
  const KEY = '02' + 'a'.repeat(64);
  const opns = { input: 'satchmo', via: 'opns-owner' as const, pubkey: KEY };
  test('⚠ an OpNS key only the index vouches for is refused', () => {
    expect(() => handoverKey({ ...opns, opnsChecked: 'chain', opnsKeySigned: false })).toThrow(/not signed on chain/);
    expect(() => handoverKey({ ...opns, opnsChecked: 'index', opnsKeySigned: true })).toThrow(/not signed on chain/);
    expect(() => handoverKey({ ...opns })).toThrow(/not signed on chain/);
  });
  test('a chain-checked, key-signed OpNS key and a paymail key are used', () => {
    expect(handoverKey({ ...opns, opnsChecked: 'chain', opnsKeySigned: true })).toBe(KEY);
    expect(handoverKey({ input: '$cafe', via: 'p2p-paymail', pubkey: KEY })).toBe(KEY);
  });
  test('no key → says so', () => {
    expect(() => handoverKey({ input: 'bob@example.com', via: 'paymail-address' })).toThrow(/Couldn't find/);
  });
});
