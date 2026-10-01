import { describe, expect, test } from 'bun:test';
import { mergeTokenBoard, parseRoom, type DirectoryToken, type HotRoom } from './indexer';

const id = (n: number) => `${String(n).padStart(64, 'a')}_0`;
const hot = (n: number, heat: number): HotRoom => ({
  ref: parseRoom('bsv21', id(n))!,
  title: `$H${n}`,
  subtitle: '',
  icon: null,
  trades: 0,
  newListings: heat,
  floorLabel: '1 sat',
  heat,
});
const dir = (n: number, outputs: number): DirectoryToken => ({ id: id(n), sym: `D${n}`, icon: null, outputs });

describe('mergeTokenBoard', () => {
  test('trending first by heat, then directory by usage, deduped', () => {
    const rows = mergeTokenBoard([hot(1, 2), hot(2, 9)], [dir(3, 50), dir(1, 40), dir(4, 10)]);
    expect(rows.map((r) => r.title)).toEqual(['$H2', '$H1', '$D3', '$D4']);
    expect(rows[1].outputs).toBe(40);
  });
  test('ignores collections', () => {
    const coll = { ...hot(5, 3), ref: parseRoom('coll', id(5))! };
    expect(mergeTokenBoard([coll], [])).toEqual([]);
  });
});
