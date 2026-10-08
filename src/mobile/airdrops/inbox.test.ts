import { describe, expect, it } from 'vitest';
import {
  badgeCount,
  emptyInbox,
  hide,
  isUnsolicited,
  keep,
  loadInbox,
  markSeen,
  saveInbox,
  toItems,
  visibleItems,
} from './inbox';
import { looksLike, poisonDataFrom, poisonWarning } from './poison';
import type { HistoryRow } from '../wallet/txHistory';

const row = (p: Partial<HistoryRow>): HistoryRow => ({
  txid: 't1',
  time: 1000,
  direction: 'in',
  amountSats: 1,
  feeSats: 0,
  counterparty: '1Sender',
  label: '',
  note: '',
  confirmations: 1,
  ...p,
});
const tok = { kind: 'token' as const, id: 'aa_1', symbol: 'FROG', qty: '100' };

describe('airdrop classification', () => {
  it('a token transfer-in with no action of ours is unsolicited', () => {
    expect(isUnsolicited(row({ type: 'transfer-in', asset: tok }), false)).toBe(true);
  });
  it('own purchases, mints and anything with an action record are not', () => {
    expect(isUnsolicited(row({ type: 'buy', asset: tok, direction: 'out' }), true)).toBe(false);
    expect(isUnsolicited(row({ type: 'mint', asset: tok }), true)).toBe(false);
    expect(isUnsolicited(row({ type: 'transfer-in', asset: tok }), true)).toBe(false);
    expect(isUnsolicited(row({ type: 'receive' }), false)).toBe(false);
  });
  it('items: token issuer is the token id, NFT issuer the sender, deduped, newest first', () => {
    const items = toItems(
      [
        row({ txid: 'a', time: 1, type: 'transfer-in', asset: tok }),
        row({ txid: 'a', time: 1, type: 'transfer-in', asset: tok }),
        row({ txid: 'b', time: 2, type: 'transfer-in', asset: { kind: 'nft', id: 'b_0' }, counterparty: '1Nft' }),
        row({ txid: 'c', time: 3, type: 'buy', asset: tok }),
      ],
      (t) => t === 'c',
    );
    expect(items.map((i) => [i.key, i.issuer])).toEqual([
      ['b:b_0', '1Nft'],
      ['a:aa_1', 'aa_1'],
    ]);
  });
});

describe('badge, keep, hide', () => {
  const items = toItems(
    [
      row({ txid: 'a', time: 100, type: 'transfer-in', asset: tok }),
      row({ txid: 'b', time: 200, type: 'transfer-in', asset: { ...tok, id: 'bb_1' } }),
      row({ txid: 'c', time: 300, type: 'transfer-in', asset: tok }),
    ],
    () => false,
  );
  it('counts items newer than last viewed', () => {
    expect(badgeCount(items, emptyInbox())).toBe(3);
    expect(badgeCount(items, markSeen(emptyInbox(), 150))).toBe(2);
    expect(badgeCount(items, markSeen(emptyInbox(), 999))).toBe(0);
  });
  it('keep removes one item; hide removes the issuer for good', () => {
    const k = keep(emptyInbox(), 'b:bb_1');
    expect(visibleItems(items, k).map((i) => i.key)).toEqual(['c:aa_1', 'a:aa_1']);
    const h = hide(emptyInbox(), items.find((i) => i.key === 'a:aa_1')!);
    expect(visibleItems(items, h).map((i) => i.key)).toEqual(['b:bb_1']);
  });
  it('onlyKnown shows only issuers kept before', () => {
    const s = { ...keep(emptyInbox(), 'a:aa_1'), onlyKnown: true };
    expect(visibleItems(items, s).map((i) => i.key)).toEqual(['c:aa_1']);
  });
  it('persists per account', () => {
    const mem = new Map<string, string>();
    const st = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    saveInbox('acct1', hide(keep(emptyInbox(), 'x'), { key: 'y', issuer: 'z' }), st);
    const back = loadInbox('acct1', st);
    expect(back.kept).toEqual(['x']);
    expect(back.hidden).toEqual(['y']);
    expect(back.hiddenIssuers).toEqual(['z']);
    expect(loadInbox('acct2', st)).toEqual(emptyInbox());
  });
});

describe('address poisoning', () => {
  const real = '1BoaseRealAddrXXXXXXXXXXXXXXXXwxyz';
  const fake = '1BoaseFakeAddrYYYYYYYYYYYYYYYYwxyz';
  it('looksLike needs same edges and a different address', () => {
    expect(looksLike(real, fake)).toBe(true);
    expect(looksLike(real, real)).toBe(false);
  });
  it('warns for a dust sender you never paid, not for past recipients', () => {
    const d = poisonDataFrom([
      { direction: 'out', amountSats: -5000, counterparty: real },
      { direction: 'in', amountSats: 1, counterparty: fake },
    ]);
    expect(poisonWarning(fake, d)).toMatch(/looks like/);
    expect(poisonWarning(real, d)).toBeNull();
    expect(poisonWarning('1SomethingElseEntirely1234567890', d)).toBeNull();
  });
});
