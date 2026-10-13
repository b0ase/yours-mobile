import { describe, expect, test } from 'bun:test';
import {
  EMPTY_FILTER,
  NO_COLLECTION,
  filterAndSort,
  formatBytes,
  groupByCollection,
  matches,
  nftTypeOf,
  toLibraryItem,
  typeCounts,
  visibleRows,
  type LibraryItem,
} from './nftLibrary';

const op = (c: string, n = 0) => `${c.repeat(64)}.${n}`;
const item = (
  name: string,
  type: string | undefined,
  tags: string[] = [],
  order = 0,
  pending = false,
  c = 'a',
): LibraryItem =>
  toLibraryItem({ output: { outpoint: op(c, order), tags }, name, type, origin: op(c, order), pending }, order);

describe('nftTypeOf', () => {
  test('media families', () => {
    expect(nftTypeOf('image/png')).toBe('image');
    expect(nftTypeOf('image/svg+xml')).toBe('image');
    expect(nftTypeOf('video/mp4')).toBe('video');
    expect(nftTypeOf('audio/mpeg; charset=binary')).toBe('audio');
    expect(nftTypeOf('TEXT/HTML;charset=utf-8')).toBe('html');
    expect(nftTypeOf('text/plain')).toBe('text');
    expect(nftTypeOf('text/markdown')).toBe('text');
    expect(nftTypeOf('application/json')).toBe('text');
  });
  test('unknown', () => {
    expect(nftTypeOf(undefined)).toBe('unknown');
    expect(nftTypeOf('')).toBe('unknown');
    expect(nftTypeOf('model/stl')).toBe('unknown');
    expect(nftTypeOf('application/octet-stream')).toBe('unknown');
  });
});

describe('toLibraryItem', () => {
  test('reads collection, listing, price and pending', () => {
    const i = item('Fox #1', 'image/png', ['collection:col1', 'ordlock2', 'price:5000'], 3, true);
    expect(i.outpoint).toBe(`${'a'.repeat(64)}_3`);
    expect(i.collection).toBe('col1');
    expect(i.listed).toBe(true);
    expect(i.price).toBe(5000);
    expect(i.pending).toBe(true);
    expect(i.type).toBe('image');
  });
  test('a withdrawn v1 listing is never shown as listed', () => {
    const i = item('old', 'image/png', ['ordlock', 'price:9000']);
    expect(i.listed).toBe(false);
    expect(i.legacyListing).toBe(true);
    expect(i.price).toBeUndefined();
  });
  test('plain item', () => {
    const i = item('x', undefined);
    expect(i.listed).toBe(false);
    expect(i.price).toBeUndefined();
    expect(i.collection).toBe('');
  });
});

describe('filters, sort, search, groups', () => {
  const all = [
    item('Track 2', 'audio/mpeg', ['collection:vex'], 0),
    item('Fox #10', 'image/png', ['collection:fox'], 1),
    item('Fox #2', 'image/png', ['collection:fox', 'ordlock2'], 2),
    item('page', 'text/html', [], 3, true),
    item('mystery', undefined, [], 4, false, 'b'),
  ];
  test('type filter', () => {
    expect(filterAndSort(all, { ...EMPTY_FILTER, types: ['image'] }, 'newest').map((i) => i.name)).toEqual([
      'Fox #10',
      'Fox #2',
    ]);
  });
  test('collection filter incl. none', () => {
    expect(all.filter((i) => matches(i, { ...EMPTY_FILTER, collection: 'vex' })).length).toBe(1);
    expect(all.filter((i) => matches(i, { ...EMPTY_FILTER, collection: NO_COLLECTION })).length).toBe(2);
  });
  test('listed and pending', () => {
    expect(all.filter((i) => matches(i, { ...EMPTY_FILTER, listedOnly: true })).map((i) => i.name)).toEqual(['Fox #2']);
    expect(all.filter((i) => matches(i, { ...EMPTY_FILTER, pendingOnly: true })).map((i) => i.name)).toEqual(['page']);
  });
  test('search by name, collection and outpoint', () => {
    expect(all.filter((i) => matches(i, { ...EMPTY_FILTER, query: 'FOX' })).length).toBe(2);
    expect(all.filter((i) => matches(i, { ...EMPTY_FILTER, query: 'vex' })).length).toBe(1);
    expect(all.filter((i) => matches(i, { ...EMPTY_FILTER, query: `${'b'.repeat(64)}.4` })).length).toBe(1);
  });
  test('sorts', () => {
    expect(filterAndSort(all, EMPTY_FILTER, 'name').map((i) => i.name)).toEqual([
      'Fox #2',
      'Fox #10',
      'mystery',
      'page',
      'Track 2',
    ]);
    expect(filterAndSort(all, EMPTY_FILTER, 'collection').map((i) => i.name)).toEqual([
      'Fox #2',
      'Fox #10',
      'Track 2',
      'mystery',
      'page',
    ]);
  });
  test('groups and type counts', () => {
    expect(groupByCollection(all)).toEqual([
      { id: NO_COLLECTION, count: 2 },
      { id: 'fox', count: 2 },
      { id: 'vex', count: 1 },
    ]);
    expect(typeCounts(all)).toEqual({ image: 2, video: 0, audio: 1, html: 1, text: 0, unknown: 1 });
  });
});

describe('helpers', () => {
  test('visibleRows windows a large grid', () => {
    expect(visibleRows(0, 600, 200, 1250)).toEqual({ first: 0, last: 6 });
    expect(visibleRows(10_000, 600, 200, 1250)).toEqual({ first: 47, last: 56 });
    expect(visibleRows(1e9, 600, 200, 10).last).toBe(10);
  });
  test('formatBytes', () => {
    expect(formatBytes(0)).toBe('');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
