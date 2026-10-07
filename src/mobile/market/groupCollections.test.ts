import { describe, expect, test } from 'bun:test';
import { groupCollections, nameStem } from './groupCollections';

const g = (name: string, collectionId: string | null = null) => ({ name, collectionId });

describe('groupCollections', () => {
  test('strips serials', () => {
    expect(nameStem('Kowry Glider #003')).toBe('Kowry Glider');
    expect(nameStem('Rocket 7')).toBe('Rocket');
    expect(nameStem('42')).toBe('42');
  });

  test('collapses repetitive collections into one tile, ranked after singles', () => {
    const items = [g('Kowry Glider #001'), g('Kowry Glider #002'), g('Cube'), g('Kowry Glider #003'), g('Car', 'c1')];
    const out = groupCollections(items);
    expect(out.map((o) => o.label)).toEqual(['Cube', 'Car', 'Kowry Glider (3)']);
    expect(out[2].count).toBe(3);
  });

  test('groups by collection id and keeps small sets as singles', () => {
    const out = groupCollections([g('A', 'x'), g('B', 'x'), g('C', 'x'), g('D', 'y'), g('E', 'y')]);
    expect(out.map((o) => o.label)).toEqual(['D', 'E', 'A (3)']);
  });

  test('expanded groups show every listing, nothing hidden', () => {
    const items = [g('G #1'), g('G #2'), g('G #3')];
    const out = groupCollections(items, new Set(['n:g']));
    expect(out.map((o) => o.label)).toEqual(['G #1', 'G #2', 'G #3']);
  });
});
