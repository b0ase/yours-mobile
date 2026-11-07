import { describe, expect, test } from 'bun:test';
import { TAIL_ENTITIES, TAIL_OFFSET_CAP, findTailOffsets, highestIds, mergedIds } from './pullTail';

/**
 * A backup as getSyncChunk pages it with no cursor: entities in the toolbox's order, each in id order with a plain
 * offset, `maxItems` rows in all (an earlier entity whose offset is short of its end fills the page first, as the
 * server does). `cap`: offsets above it are refused (the smallest profile's 100k).
 */
const backup = (rows: Record<string, number[]>, cap = Infinity) => {
  const offsetsSeen: number[] = [];
  let probes = 0;
  const get = async (a: Record<string, unknown>) => {
    probes++;
    const offsets = a.offsets as { name: string; offset: number }[];
    for (const o of offsets) {
      offsetsSeen.push(o.offset);
      if (o.offset > cap) throw new Error(`offset ${o.offset} exceeds the cap`);
    }
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
  return { get, probes: () => probes, maxOffset: () => Math.max(0, ...offsetsSeen), rows };
};
const offsetOf = (r: { tail: { name: string; offset: number }[] | null }, name: string) =>
  r.tail?.find((o) => o.name === name)?.offset;
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

describe("findTailOffsets: the first backup row this device never merged, by the backup's insert order", () => {
  test('in step: null; earlier entities skipped by their real counts, never a huge offset', async () => {
    const b = backup({ provenTx: range(1, 40), transaction: [10, 20, 30], output: [5, 6], txLabelMap: [1, 2, 3] });
    const r = await findTailOffsets(b.get, {}, { provenTx: range(1, 40), transaction: [10, 20, 30], output: [5, 6] });
    expect(r.tail).toBeNull();
    expect(b.maxOffset()).toBeLessThanOrEqual(41);
    expect(r.memo.counts).toMatchObject({ provenTx: 40, transaction: 3, output: 2, txLabelMap: 3 });
    expect(r.memo.seen).toMatchObject({ provenTx: 40, transaction: 30, output: 6 });
  });
  test('a row inserted late among the others (38521 between 38520 and 38522): found at its offset', async () => {
    const b = backup({ transaction: [38519, 38520, 38521, 38522, 38600], txLabelMap: [1, 2] });
    const r = await findTailOffsets(b.get, {}, { transaction: [38519, 38520, 38522, 38600] });
    expect(offsetOf(r, 'transaction')).toBe(2);
    expect(offsetOf(r, 'txLabelMap')).toBe(0); // its parent has a missing row: label links read again
    expect(offsetOf(r, 'outputTagMap')).toBe(0); // (no rows: count 0)
  });
  test('link tables are skipped (at their counts) when their parents are in step', async () => {
    const b = backup({ transaction: [1, 2], output: [1, 2, 3], outputTagMap: range(1, 50), provenTxReq: [1, 2] });
    const r = await findTailOffsets(b.get, {}, { transaction: [1, 2], output: [1, 2, 3], provenTxReq: [1] });
    expect(offsetOf(r, 'provenTxReq')).toBe(1);
    expect(offsetOf(r, 'outputTagMap')).toBe(50);
  });
  test('new rows after the last one this device knows: the tail starts right after it', async () => {
    const b = backup({ output: [1, 2, 3, 4, 5] });
    expect(offsetOf(await findTailOffsets(b.get, {}, { output: [1, 2, 3] }), 'output')).toBe(3);
  });
  test('this device has none of an entity the backup has: from 0', async () => {
    const b = backup({ commission: [7] });
    expect(offsetOf(await findTailOffsets(b.get, {}, {}), 'commission')).toBe(0);
  });
  test('a purged backup row: one tail from the hole, then never again once `seen` passes it', async () => {
    const b = backup({ transaction: [1, 2, 4, 5, 6] }); // 3 purged on the backup (failed tx, 5 days), 6 new
    const first = await findTailOffsets(b.get, {}, { transaction: [1, 2, 3, 4, 5] });
    expect(offsetOf(first, 'transaction')).toBe(2); // earlier, never later
    // The tail pass merges 4, 5, 6; it completes and confirms the highest id it holds.
    const after = { transaction: [1, 2, 3, 4, 5, 6] };
    const memo = { seen: highestIds(after), counts: first.memo.counts };
    const again = await findTailOffsets(b.get, {}, after, memo);
    expect(again.tail).toBeNull(); // the hole at 3 is below `seen`: not read again
    b.rows.transaction.push(7); // a new row later: found above `seen`
    const third = await findTailOffsets(b.get, {}, after, again.memo);
    expect(offsetOf(third, 'transaction')).toBe(5);
  });
  test('with `seen`, an unchanged backup costs two probes per entity', async () => {
    const rows = { provenTx: range(1, 300), transaction: range(1, 120), output: range(1, 480) };
    const b = backup(rows);
    const first = await findTailOffsets(b.get, {}, rows);
    const before = b.probes();
    expect((await findTailOffsets(b.get, {}, rows, first.memo)).tail).toBeNull();
    expect(b.probes() - before).toBeLessThanOrEqual(2 * TAIL_ENTITIES.length + 6);
  });
  test('a backup that refuses a probe (its own lower cap): throws (the caller backs off 30 min)', async () => {
    const b = backup({ transaction: [1, 2, 3] }, 2);
    await expect(findTailOffsets(b.get, {}, { transaction: [1, 2] })).rejects.toThrow();
  });
  test('an entity past TAIL_OFFSET_CAP rows: no throw; it and the entities after it are left unchecked, with a log line', async () => {
    const huge = range(1, TAIL_OFFSET_CAP + 5);
    const b = backup({ provenTx: [1, 2], output: huge, provenTxReq: [1, 2, 3] }, TAIL_OFFSET_CAP);
    const logs: string[] = [];
    const r = await findTailOffsets(b.get, {}, { provenTx: [1], output: huge, provenTxReq: [1, 2] }, {}, (m) =>
      logs.push(m),
    );
    expect(b.maxOffset()).toBeLessThanOrEqual(TAIL_OFFSET_CAP);
    // No tail pass then (it could not skip that entity either); the weekly full pass covers it.
    expect(r.tail).toBeNull();
    expect(r.skipped).toBe('output');
    expect(logs.join(' ')).toContain('output');
  });
  test("RB's wallet size (extension copy, 7 Nov: 395 proofs, 430 txs, 1,735 outputs, 942 label links, 852 tag links, 395 requests): a few dozen probes", async () => {
    const rows = {
      provenTx: range(4_000, 4_394),
      outputBasket: range(1, 10),
      outputTag: range(1, 371),
      txLabel: range(1, 61),
      transaction: range(8_000, 8_429),
      output: range(57_000, 58_734),
      txLabelMap: range(1, 942),
      outputTagMap: range(1, 852),
      provenTxReq: range(6_000, 6_394),
    };
    const b = backup(structuredClone(rows), TAIL_OFFSET_CAP);
    const first = await findTailOffsets(b.get, {}, rows);
    expect(first.tail).toBeNull();
    expect(b.probes()).toBeLessThanOrEqual(80); // the first check finds the link tables' counts
    const before = b.probes();
    // A row that reaches the backup late gets a new, higher id (8430), whatever its times say.
    b.rows.transaction.push(8_430);
    const r = await findTailOffsets(b.get, {}, rows, first.memo);
    expect(offsetOf(r, 'transaction')).toBe(430);
    expect(offsetOf(r, 'txLabelMap')).toBe(0);
    expect(offsetOf(r, 'outputTagMap')).toBe(852);
    expect(b.probes() - before).toBeLessThanOrEqual(45);
  });
});

describe('mergedIds', () => {
  test("per entity, the backup ids of the sync state's idMap, numerically sorted (JSON or object)", () => {
    const sm = { transaction: { idMap: { '38521': 9, '100': 1, '2000': 5 } }, output: { idMap: {} } };
    expect(mergedIds(JSON.stringify(sm)).transaction).toEqual([100, 2000, 38521]);
    expect(mergedIds(sm).output).toEqual([]);
    expect(highestIds(mergedIds(sm))).toEqual({ transaction: 38521 });
  });
});
