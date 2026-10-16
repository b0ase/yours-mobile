import { describe, expect, it } from 'bun:test';
import type { Contact } from '../chat/contacts';
import { DAY_MS, candidateName, dueNames, joinNotices, markSeen, runJoinChecks, withJoined } from './joinMatch';

const c = (p: Partial<Contact>): Contact => ({
  id: p.id ?? p.name ?? 'x',
  name: p.name ?? '',
  handle: null,
  paymail: null,
  identityKey: null,
  address: null,
  avatar: null,
  bchatId: null,
  sources: [],
  ...p,
});

describe('contacts auto-match', () => {
  it('picks the name to try from handle, @x, $handcash or email', () => {
    expect(candidateName(c({ name: 'Mike', handle: 'mike' }))).toBe('mike');
    expect(candidateName(c({ name: '@Mike_X' }))).toBe('mike_x');
    expect(candidateName(c({ name: '$mike' }))).toBe('mike');
    expect(candidateName(c({ name: 'mike+news@gmail.com' }))).toBe('mike');
    expect(candidateName(c({ name: 'Mike Smith' }))).toBeNull();
    expect(candidateName(c({ name: '@mike', paymail: 'mike@handcash.io' }))).toBeNull();
  });

  it('checks each name at most once a day and in small batches', () => {
    const list = Array.from({ length: 8 }, (_, i) => c({ name: `@u${i}` }));
    expect(dueNames(list, {}, 1000, 5)).toEqual(['u0', 'u1', 'u2', 'u3', 'u4']);
    const st = { u0: { checkedAt: 1000 }, u1: { checkedAt: 1000 - DAY_MS } };
    expect(dueNames(list, st, 1000 + 10, 2)).toEqual(['u1', 'u2']);
    expect(dueNames([c({ name: '@a', id: '1' }), c({ name: '$a', id: '2' })], {}, 0)).toEqual(['a']);
  });

  it('looks names up one at a time and records matches', async () => {
    const asked: string[] = [];
    const list = [c({ name: '@mike' }), c({ name: 'ann@gmail.com' }), c({ name: 'Bob' })];
    const st = await runJoinChecks(
      list,
      {},
      async (n) => {
        asked.push(n);
        if (n === 'ann') throw new Error('network');
        return n === 'mike' ? 'mike@bwalletx.com' : null;
      },
      5,
    );
    expect(asked).toEqual(['mike', 'ann']);
    expect(st.mike).toEqual({ checkedAt: 5, paymail: 'mike@bwalletx.com' });
    expect(st.ann).toEqual({ checkedAt: 5 });
    expect(dueNames(list, st, 5 + DAY_MS * 2)).toEqual(['ann']);

    const shown = withJoined(list, st);
    expect(shown[0].paymail).toBe('mike@bwalletx.com');
    expect(shown[1].paymail).toBeNull();
    expect(joinNotices(list, st)).toEqual([{ name: 'mike', who: 'mike', paymail: 'mike@bwalletx.com' }]);
    expect(joinNotices(list, markSeen(st, 'mike'))).toEqual([]);
  });
});
