import { describe, expect, test } from 'bun:test';
import { TAIL_ENTITIES, findTailOffsets, mergedIds } from './pullTail';

/** A backup as getSyncChunk pages it with no cursor: each entity in id order, a plain offset, `maxItems` rows. */
const backup = (rows: Record<string, number[]>) => {
  let probes = 0;
  const get = async (a: Record<string, unknown>) => {
    probes++;
    const offsets = a.offsets as { name: string; offset: number }[];
    let left = a.maxItems as number;
    const out: Record<string, unknown> = {};
    TAIL_ENTITIES.forEach((e, i) => {
      const ids = (rows[e.name] ?? []).slice().sort((x, y) => x - y);
      const page = left > 0 ? ids.slice(offsets[i].offset, offsets[i].offset + left) : [];
      left -= page.length;
      out[e.key] = page.map((id) => ({ [e.id ?? 'x']: id }));
    });
    return out;
  };
  return { get, probes: () => probes };
};
const offsetOf = (r: { name: string; offset: number }[] | null, name: string) =>
  r?.find((o) => o.name === name)?.offset;

describe("findTailOffsets: the first backup row this device never merged, by the backup's insert order", () => {
  test('in step: null, two probes per entity that has rows', async () => {
    const b = backup({ transaction: [10, 20, 30], output: [5, 6] });
    expect(await findTailOffsets(b.get, {}, { transaction: [10, 20, 30], output: [5, 6] })).toBeNull();
    expect(b.probes()).toBeLessThanOrEqual(2 * 2 + (TAIL_ENTITIES.filter((e) => e.id).length - 2));
  });
  test('a row inserted late with an id among the others (38521 between 38520 and 38522): found at its offset', async () => {
    const b = backup({ transaction: [38519, 38520, 38521, 38522, 38600] });
    const r = await findTailOffsets(b.get, {}, { transaction: [38519, 38520, 38522, 38600] });
    expect(offsetOf(r, 'transaction')).toBe(2);
    expect(offsetOf(r, 'txLabelMap')).toBe(0); // link rows have no ids: read again from the start
  });
  test('new rows after the last one this device knows: the tail starts right after it', async () => {
    const b = backup({ output: [1, 2, 3, 4, 5] });
    expect(offsetOf(await findTailOffsets(b.get, {}, { output: [1, 2, 3] }), 'output')).toBe(3);
  });
  test('this device has none of an entity the backup has: from 0', async () => {
    const b = backup({ commission: [7] });
    expect(offsetOf(await findTailOffsets(b.get, {}, {}), 'commission')).toBe(0);
  });
  test('a row the backup deleted (still in the map): the tail starts earlier, never later', async () => {
    const b = backup({ transaction: [1, 2, 4, 5, 6] }); // 3 purged on the backup, 6 new
    expect(offsetOf(await findTailOffsets(b.get, {}, { transaction: [1, 2, 3, 4, 5] }), 'transaction')).toBe(2);
  });
});

describe('mergedIds', () => {
  test("per entity, the backup ids of the sync state's idMap, numerically sorted (JSON or object)", () => {
    const sm = { transaction: { idMap: { '38521': 9, '100': 1, '2000': 5 } }, output: { idMap: {} } };
    expect(mergedIds(JSON.stringify(sm)).transaction).toEqual([100, 2000, 38521]);
    expect(mergedIds(sm).output).toEqual([]);
  });
});
