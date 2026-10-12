import { describe, expect, test } from 'bun:test';
import {
  arrange,
  emptyPrefs,
  movePinned,
  roomKeyOf,
  setArchived,
  setHidden,
  setMarked,
  setMuted,
  setPinned,
  settle,
  type ListPrefs,
} from './listPrefs';

type Row = { k: string; at: number };
const rows: Row[] = [
  { k: 'A', at: 10 },
  { k: 'B', at: 30 },
  { k: 'C', at: 20 },
  { k: 'D', at: 40 },
];
const run = (p: ListPrefs, items = rows) =>
  arrange(
    items,
    p,
    (r) => r.k,
    (r) => r.at,
  );
const keys = (xs: Row[]) => xs.map((r) => r.k);

describe('list sorting', () => {
  test('no prefs: newest activity first', () => {
    expect(keys(run(emptyPrefs()).main)).toEqual(['D', 'B', 'C', 'A']);
  });
  test('pinned first, in pinned order; newly pinned goes first', () => {
    let p = setPinned(emptyPrefs(), 'A', true);
    p = setPinned(p, 'C', true);
    expect(p.pinned).toEqual(['C', 'A']);
    expect(keys(run(p).main)).toEqual(['C', 'A', 'D', 'B']);
    p = movePinned(p, 'C', 1);
    expect(p.pinned).toEqual(['A', 'C']);
    expect(keys(run(p).main)).toEqual(['A', 'C', 'D', 'B']);
    p = setPinned(p, 'A', false);
    expect(keys(run(p).main)).toEqual(['C', 'D', 'B', 'A']);
  });
});

describe('mute', () => {
  test('toggles and does not change order', () => {
    const p = setMuted(emptyPrefs(), 'B', true);
    expect(p.muted).toEqual(['B']);
    expect(keys(run(p).main)).toEqual(['D', 'B', 'C', 'A']);
    expect(setMuted(p, 'B', false).muted).toEqual([]);
  });
});

describe('archive', () => {
  test('archived chats leave the main list and unpin', () => {
    const p = setArchived(setPinned(emptyPrefs(), 'B', true), 'B', true, 30);
    expect(p.pinned).toEqual([]);
    const a = run(p);
    expect(keys(a.main)).toEqual(['D', 'C', 'A']);
    expect(keys(a.archived)).toEqual(['B']);
    expect(a.unarchive).toEqual([]);
  });
  test('a new message un-archives the chat', () => {
    const p = setArchived(emptyPrefs(), 'B', true, 30);
    const a = run(p, [...rows.filter((r) => r.k !== 'B'), { k: 'B', at: 50 }]);
    expect(keys(a.main)[0]).toBe('B');
    expect(a.unarchive).toEqual(['B']);
    expect(settle(p, a).archived).toEqual({});
  });
  test('a muted chat stays archived on a new message', () => {
    const p = setMuted(setArchived(emptyPrefs(), 'B', true, 30), 'B', true);
    const a = run(p, [...rows.filter((r) => r.k !== 'B'), { k: 'B', at: 50 }]);
    expect(keys(a.archived)).toEqual(['B']);
    expect(a.unarchive).toEqual([]);
    expect(settle(p, a)).toBe(p);
  });
});

describe('delete (hide) and marked unread', () => {
  test('hidden until a newer message arrives', () => {
    const p = setHidden(emptyPrefs(), 'D', true, 40);
    expect(keys(run(p).main)).toEqual(['B', 'C', 'A']);
    const a = run(p, [...rows.filter((r) => r.k !== 'D'), { k: 'D', at: 41 }]);
    expect(keys(a.main)[0]).toBe('D');
    expect(settle(p, a).hidden).toEqual({});
  });
  test('marked unread toggles', () => {
    const p = setMarked(emptyPrefs(), 'A', true);
    expect(p.marked).toEqual(['A']);
    expect(setMarked(p, 'A', false).marked).toEqual([]);
  });
  test('room keys ignore $ and case', () => {
    expect(roomKeyOf('$lounge')).toBe(roomKeyOf('LOUNGE'));
  });
});
