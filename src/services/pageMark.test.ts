/**
 * pageMark (inboundSync.ts) is markOf(row) read from the page's one parse. Whatever the row holds, the two must agree:
 * a double-encoded map parses to a string, which is not a map, so it goes to markOf as the row (review of cb8bd1d9).
 */
import { describe, expect, test } from 'bun:test';
import { markOf, type SyncStateRow } from './fullPass';
import { pageMark, type PageSyncMap } from './inboundSync';

const MARKED = { bwxFullPass: { startedAt: 5 }, transaction: { idMap: { '1': 2 } } };

const rows: [string, SyncStateRow | undefined][] = [
  ['no row', undefined],
  ['no map', {}],
  ['empty text', { syncMap: '' }],
  ['unparsable text', { syncMap: '{not json' }],
  ['a map as text', { syncMap: JSON.stringify(MARKED) }],
  ['a map already parsed', { syncMap: MARKED }],
  ['a double-encoded map', { syncMap: JSON.stringify(JSON.stringify(MARKED)) }],
  ['null as text', { syncMap: 'null' }],
  ['a number as text', { syncMap: '7' }],
  ['an array as text', { syncMap: '[1,2]' }],
  ['true as text', { syncMap: 'true' }],
];

describe('pageMark agrees with markOf', () => {
  for (const [name, row] of rows)
    test(name, () => {
      const once: PageSyncMap = {};
      expect(pageMark(row, once)).toEqual(markOf(row));
      // A second read of the same page (the memo is warm) still agrees.
      expect(pageMark(row, once)).toEqual(markOf(row));
      expect(pageMark(row, undefined)).toEqual(markOf(row));
    });

  test('the double-encoded map is not read as a mark', () => {
    expect(pageMark({ syncMap: JSON.stringify(JSON.stringify(MARKED)) }, {})).toEqual({});
  });
});
