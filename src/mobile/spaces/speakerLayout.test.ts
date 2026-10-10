import { describe, expect, test } from 'bun:test';
import { gridShape, pagesOf, recentlyActive, spareCells, tvWidth, wantsLiveVideo } from './speakerLayout';

const P = (n: number) => Array.from({ length: n }, (_, i) => ({ handle: `s${i}` }));

describe('gridShape', () => {
  test.each([
    [1, 1, 1],
    [2, 1, 2],
    [3, 2, 2],
    [4, 2, 2],
    [5, 3, 3],
    [9, 3, 3],
    [10, 4, 4],
    [16, 4, 4],
    [40, 4, 4],
  ])('%i speakers → %i×%i', (n, cols, rows) => {
    expect(gridShape(n).cols).toBe(cols);
    expect(gridShape(n).rows).toBe(rows);
  });
  test('small tiles from 3×3, dense from 4×4', () => {
    expect(gridShape(4).small).toBe(false);
    expect(gridShape(5).small).toBe(true);
    expect(gridShape(9).dense).toBe(false);
    expect(gridShape(10).dense).toBe(true);
  });
});

describe('TV-shaped tiles', () => {
  test('16:9 cells up to 2×2, square from 3×3; never stretched', () => {
    for (const n of [1, 2, 3, 4]) expect(gridShape(n).aspect).toBe('16 / 9');
    for (const n of [5, 9, 10, 16, 40]) expect(gridShape(n).aspect).toBe('1 / 1');
  });
  test('a single tile is full width but height-capped', () => {
    expect(tvWidth()).toBe(`min(100%, ${(55 * 16) / 9}vh)`);
    expect(tvWidth(90)).toBe('min(100%, 160vh)');
  });
});

describe('spareCells', () => {
  test('none for 1, 2 or a full grid', () => {
    expect(spareCells(1)).toBe(0);
    expect(spareCells(2)).toBe(0);
    expect(spareCells(4)).toBe(0);
    expect(spareCells(9)).toBe(0);
    expect(spareCells(16)).toBe(0);
  });
  test('the rest of the grid', () => {
    expect(spareCells(3)).toBe(1);
    expect(spareCells(5)).toBe(4);
    expect(spareCells(10)).toBe(6);
    expect(spareCells(17)).toBe(15);
  });
});

describe('pagesOf', () => {
  test('one page up to 16', () => expect(pagesOf(P(16), new Set())).toHaveLength(1));
  test('pages past 16, active speakers first', () => {
    const pages = pagesOf(P(20), new Set(['s18', 's19']));
    expect(pages.map((p) => p.length)).toEqual([16, 4]);
    expect(pages[0].slice(0, 2).map((p) => p.handle)).toEqual(['s18', 's19']);
    expect(pages[1].map((p) => p.handle)).toEqual(['s14', 's15', 's16', 's17']);
  });
  test('keeps order up to 16 even with active speakers', () =>
    expect(pagesOf(P(3), new Set(['s2']))[0][0].handle).toBe('s0'));
});

describe('live video', () => {
  const recent = recentlyActive(new Map([['a', 1_000], ['b', 20_000]]), 25_000);
  test('recent window is ~10 s', () => expect([...recent]).toEqual(['b']));
  const base = { recent, expanded: null, me: 'me', onPage: true };
  test('everyone below 4×4', () => expect(wantsLiveVideo({ ...base, handle: 'a', count: 9 })).toBe(true));
  test('only the recent at 4×4', () => {
    expect(wantsLiveVideo({ ...base, handle: 'a', count: 12 })).toBe(false);
    expect(wantsLiveVideo({ ...base, handle: 'b', count: 12 })).toBe(true);
  });
  test('me and the expanded tile always', () => {
    expect(wantsLiveVideo({ ...base, handle: 'me', count: 12 })).toBe(true);
    expect(wantsLiveVideo({ ...base, handle: 'a', count: 12, expanded: 'a' })).toBe(true);
  });
  test('off-page tiles pause', () => expect(wantsLiveVideo({ ...base, handle: 'b', count: 20, onPage: false })).toBe(false));
});
