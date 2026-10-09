import { describe, expect, it } from 'vitest';
import {
  emptyInbox,
  keep,
  hide,
  quarantineFor,
  saveInbox,
  saveItems,
  saveSolicited,
  visibleItems,
  type AirdropItem,
} from './inbox';
import { normId, quarantinedNfts, quarantinedTokenIds, trustIssuer, withoutQuarantined } from './quarantine';

const tok = (key: string, id: string, issuer = id): AirdropItem => ({
  key,
  txid: key.split(':')[0],
  time: 1,
  asset: { kind: 'token', id, qty: '100' },
  issuer,
  from: '1From',
});
const nft = (key: string, id: string, issuer = '1Sender'): AirdropItem => ({
  key,
  txid: key.split(':')[0],
  time: 1,
  asset: { kind: 'nft', id, qty: '1' },
  issuer,
  from: issuer,
});
const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('token quarantine', () => {
  const items = [tok('a:x', 'aaa_0'), tok('b:x', 'bbb_0'), tok('c:x', 'BBB.0')];

  it('quarantines unsolicited tokens that were never kept', () => {
    expect([...quarantinedTokenIds(items, emptyInbox())].sort()).toEqual(['aaa_0', 'bbb_0']);
  });

  it('Keep on any item of a token un-quarantines that token (it stays at the same address)', () => {
    const q = quarantinedTokenIds(items, keep(emptyInbox(), 'c:x'));
    expect([...q]).toEqual(['aaa_0']);
  });

  it('Hide does not release a token from quarantine', () => {
    expect(quarantinedTokenIds(items, hide(emptyInbox(), items[0])).has('aaa_0')).toBe(true);
  });

  it('trusting the sender releases all their tokens and un-hides them', () => {
    const s = trustIssuer(hide(emptyInbox(), items[0]), 'aaa_0');
    expect(quarantinedTokenIds(items, s).has('aaa_0')).toBe(false);
    expect(s.hiddenIssuers).toEqual([]);
    expect(visibleItems(items, s).some((i) => i.issuer === 'aaa_0')).toBe(false);
  });

  it('never quarantines a token the wallet holds by its own doing', () => {
    expect(quarantinedTokenIds(items, emptyInbox(), ['AAA.0']).has('aaa_0')).toBe(false);
  });

  it('withoutQuarantined drops quarantined balances from lists, sends and sweeps', () => {
    const bals = [{ id: 'aaa.0' }, { id: 'zzz_1' }, { id: undefined }];
    expect(withoutQuarantined(bals, new Set(['aaa_0']))).toEqual([{ id: 'zzz_1' }, { id: undefined }]);
    expect(withoutQuarantined(bals, new Set())).toBe(bals);
  });

  it('quarantines NFTs per item until kept or the sender is trusted', () => {
    const ns = [nft('n1:x', 'tx1_0'), nft('n2:x', 'tx2.0', '1Other')];
    expect([...quarantinedNfts(ns, emptyInbox())].sort()).toEqual(['tx1_0', 'tx2_0']);
    expect([...quarantinedNfts(ns, keep(emptyInbox(), 'n1:x'))]).toEqual(['tx2_0']);
    expect([...quarantinedNfts(ns, trustIssuer(emptyInbox(), '1Other'))]).toEqual(['tx1_0']);
  });

  it('quarantines nothing until History has been scanned once (no false hides of bought tokens)', () => {
    const st = mem();
    saveItems('acct', items, 1, st);
    saveInbox('acct', emptyInbox(), st);
    expect(quarantineFor('acct', st).size).toBe(0);
    saveSolicited('acct', [], st);
    expect(quarantineFor('acct', st).has('aaa_0')).toBe(true);
  });

  it('normId treats txid.vout and txid_vout alike', () => {
    expect(normId('ABC.1')).toBe(normId('abc_1'));
  });
});
