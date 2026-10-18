import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  arrangeRows,
  emptyRowPrefs,
  hiddenCount,
  loadRowPrefs,
  onRowPrefs,
  saveRowPrefs,
  toggleHidden,
  togglePinned,
  type RowPrefs,
} from './rowPrefs';

// A small in-memory localStorage for these tests only (put back afterwards: other files share the global).
const mem = new Map<string, string>();
const g = globalThis as unknown as { localStorage?: unknown };
const had = g.localStorage;
beforeAll(() => {
  g.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    clear: () => mem.clear(),
  };
});
afterAll(() => {
  if (had === undefined) delete g.localStorage;
  else g.localStorage = had;
});

const rows = ['a', 'b', 'c', 'd', 'e'];
const id = (s: string) => s;
const P = (pinned: string[], hidden: string[] = []): RowPrefs => ({ pinned, hidden });

describe('togglePinned / toggleHidden', () => {
  test('pin appends, unpin removes', () => {
    const p = togglePinned(togglePinned(emptyRowPrefs(), 'c'), 'a');
    expect(p.pinned).toEqual(['c', 'a']);
    expect(togglePinned(p, 'c').pinned).toEqual(['a']);
  });
  test('hide unpins; unhide restores the row only', () => {
    const p = toggleHidden(P(['a', 'b']), 'a');
    expect(p).toEqual(P(['b'], ['a']));
    expect(toggleHidden(p, 'a')).toEqual(P(['b'], []));
  });
});

describe('arrangeRows', () => {
  test('no prefs keeps the list order', () => expect(arrangeRows(rows, id, emptyRowPrefs())).toEqual(rows));
  test('pinned first in pin order, the rest in list order', () =>
    expect(arrangeRows(rows, id, P(['d', 'b']))).toEqual(['d', 'b', 'a', 'c', 'e']));
  test('hidden rows leave the list', () => expect(arrangeRows(rows, id, P([], ['b', 'e']))).toEqual(['a', 'c', 'd']));
  test('the Hidden view shows only hidden rows, in list order', () =>
    expect(arrangeRows(rows, id, P(['a'], ['e', 'b']), true)).toEqual(['b', 'e']));
  test('pins for tokens not in this list are ignored', () =>
    expect(arrangeRows(rows, id, P(['zz', 'c']))).toEqual(['c', 'a', 'b', 'd', 'e']));
  test('hiddenCount counts only this list', () => expect(hiddenCount(rows, id, P([], ['a', 'zz']))).toBe(1));
});

describe('storage', () => {
  beforeEach(() => localStorage.clear());
  test('per account, round trip', () => {
    saveRowPrefs('acct1', P(['a'], ['b']));
    expect(loadRowPrefs('acct1')).toEqual(P(['a'], ['b']));
    expect(loadRowPrefs('acct2')).toEqual(emptyRowPrefs());
  });
  test('no account: nothing saved, empty prefs', () => {
    saveRowPrefs(null, P(['a']));
    expect(loadRowPrefs(null)).toEqual(emptyRowPrefs());
  });
  test('junk in storage reads as empty', () => {
    localStorage.setItem('bwx:xrows:acct1', '{"pinned":[1,"a"],"hidden":"x"}');
    expect(loadRowPrefs('acct1')).toEqual(P(['a'], []));
    localStorage.setItem('bwx:xrows:acct1', 'not json');
    expect(loadRowPrefs('acct1')).toEqual(emptyRowPrefs());
  });
  test('saves notify every list', () => {
    let n = 0;
    const off = onRowPrefs(() => n++);
    saveRowPrefs('acct1', P(['a']));
    off();
    saveRowPrefs('acct1', P([]));
    expect(n).toBe(1);
  });
});
