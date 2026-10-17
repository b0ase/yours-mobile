import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Found, ScanResult } from '../../sweep/relayxRecover';
import { loadSavedRelayx, saveRelayxResult } from './relayxSaved';

const nft = (origin: string, extra: Partial<Found> = {}): Found => ({
  location: origin,
  origin,
  title: 'NPG #0001',
  collection: 'NPG',
  address: '1Addr',
  wif: 'secret-wif',
  ...extra,
});
const result = (nfts: Found[]): ScanResult => ({ nfts, otherSats: 0, otherOutputs: 0, addresses: 1 });

describe('relayxSaved', () => {
  const g = globalThis as { localStorage?: Storage };
  let prev: Storage | undefined;
  beforeEach(() => {
    prev = g.localStorage;
    const m = new Map<string, string>();
    g.localStorage = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
      clear: () => m.clear(),
      key: (i: number) => [...m.keys()][i] ?? null,
      get length() {
        return m.size;
      },
    } as Storage;
  });
  afterEach(() => {
    g.localStorage = prev;
  });

  test('nothing saved reads as null', () => {
    expect(loadSavedRelayx('xpubA')).toBeNull();
  });

  test('round-trips per xpub, strips keys and drops unread', () => {
    saveRelayxResult(result([nft('a_0'), nft('b_0', { unread: true })]), 'xpub-one-1234567890abcdef');
    const s = loadSavedRelayx('xpub-one-1234567890abcdef');
    expect(s?.result.nfts.map((n) => n.origin)).toEqual(['a_0']);
    expect(s?.result.nfts[0].wif).toBe('');
    expect(loadSavedRelayx('xpub-two-0000000000000000')).toBeNull();
    expect(loadSavedRelayx()).toBeNull();
  });

  test('an empty or broken save reads as null', () => {
    saveRelayxResult(result([]), 'xpubB');
    expect(loadSavedRelayx('xpubB')).toBeNull();
    g.localStorage!.setItem('bw.relayx.lastsearch.v1', '{not json');
    expect(loadSavedRelayx()).toBeNull();
  });
});
