/**
 * Rows that land on the backup late, with times older than this device's pull cursor (extension, 6 Nov 2026: the phone
 * pushed 8734977f, backup tx 38521, at 02:37 carrying 02:03 times; the extension's incremental pull, 15 minutes of
 * overlap, never asked for it, and ~3.5M sats of coins were missing there).
 *
 * The toolbox pages a pull by `updated_at >= since`, but WITHOUT a cursor (since unset) it pages each entity in the
 * backup's own primary-key order (StorageKnex pagingOrder; the same in StorageIdb) with a plain offset. The backup's ids
 * only grow, so that order is the order rows reached the backup. This device's sync state for the backup keeps, per
 * entity, the backup ids of every row it has merged (its idMap). So the first row this device never had is found by
 * comparing the backup's id at an offset with the k-th smallest id in the map, with one-row probes: two per entity when
 * nothing is missing (the last row the map knows, and whether anything follows it), a binary search otherwise. A pass
 * then reads only from there (requestTailPass, services/fullPass.ts).
 *
 * A row the backup deleted (but the map still names) makes the search stop earlier, so the pass reads a little more,
 * never less. A missing row and a deleted row that cancel out exactly are left to the weekly full pass.
 */

/** The toolbox's entity order (EntitySyncState.makeRequestSyncChunkArgs) and each entity's chunk key and id field. */
export const TAIL_ENTITIES = [
  { name: 'provenTx', key: 'provenTxs', id: 'provenTxId' },
  { name: 'outputBasket', key: 'outputBaskets', id: 'basketId' },
  { name: 'outputTag', key: 'outputTags', id: 'outputTagId' },
  { name: 'txLabel', key: 'txLabels', id: 'txLabelId' },
  { name: 'transaction', key: 'transactions', id: 'transactionId' },
  { name: 'output', key: 'outputs', id: 'outputId' },
  { name: 'txLabelMap', key: 'txLabelMaps', id: null },
  { name: 'outputTagMap', key: 'outputTagMaps', id: null },
  { name: 'certificate', key: 'certificates', id: 'certificateId' },
  { name: 'certificateField', key: 'certificateFields', id: null },
  { name: 'commission', key: 'commissions', id: 'commissionId' },
  { name: 'provenTxReq', key: 'provenTxReqs', id: 'provenTxReqId' },
] as const;

/** An offset past any entity's end: the probe's earlier entities return nothing. */
const PAST_END = 1_000_000_000;

export type GetSyncChunk = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** The backup ids this device has merged, per entity (the sync state's syncMap idMaps). */
export function mergedIds(syncMap: unknown): Record<string, number[]> {
  const m = (typeof syncMap === 'string' ? JSON.parse(syncMap) : syncMap) as Record<string, { idMap?: object }> | null;
  const out: Record<string, number[]> = {};
  for (const e of TAIL_ENTITIES) {
    const ids = Object.keys(m?.[e.name]?.idMap ?? {})
      .map(Number)
      .filter((n) => Number.isFinite(n));
    out[e.name] = ids.sort((a, b) => a - b);
  }
  return out;
}

/**
 * Per-entity offsets for a tail pass: for an entity with ids, the offset of the first backup row this device never
 * merged (or its end when none); for the link entities (no ids of their own, paged by their composite key), 0. Null
 * when nothing is missing. `base` carries identityKey, fromStorageIdentityKey, toStorageIdentityKey.
 */
export async function findTailOffsets(
  get: GetSyncChunk,
  base: Record<string, unknown>,
  merged: Record<string, number[]>,
): Promise<{ name: string; offset: number }[] | null> {
  const probe = async (index: number, offset: number): Promise<number | undefined> => {
    const offsets = TAIL_ENTITIES.map((e, i) => ({
      name: e.name,
      offset: i < index ? PAST_END : i === index ? offset : 0,
    }));
    const chunk = await get({ ...base, since: undefined, maxItems: 1, maxRoughSize: 10_000_000, offsets });
    const e = TAIL_ENTITIES[index];
    const row = (chunk[e.key] as Record<string, unknown>[] | undefined)?.[0];
    const id = row?.[e.id as string];
    return typeof id === 'number' ? id : undefined;
  };
  const starts = new Map<string, number>();
  let missing = false;
  for (let i = 0; i < TAIL_ENTITIES.length; i++) {
    const e = TAIL_ENTITIES[i];
    if (!e.id) continue;
    const m = merged[e.name] ?? [];
    const n = m.length;
    let start = n;
    if (n === 0) {
      if ((await probe(i, 0)) === undefined) continue; // none on either side
      start = 0;
    } else if ((await probe(i, n - 1)) === m[n - 1]) {
      // Every row up to the last one this device knows is in step; anything after it is new to this device.
      if ((await probe(i, n)) === undefined) {
        starts.set(e.name, n);
        continue;
      }
    } else {
      // The first offset where the backup's row is not the one this device has at that place.
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((await probe(i, mid)) === m[mid]) lo = mid + 1;
        else hi = mid;
      }
      start = lo;
    }
    starts.set(e.name, start);
    missing = true;
  }
  if (!missing) return null;
  return TAIL_ENTITIES.map((e) => ({ name: e.name, offset: e.id ? (starts.get(e.name) ?? 0) : 0 }));
}
