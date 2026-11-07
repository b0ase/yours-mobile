/**
 * Rows that land on the backup late, with times older than this device's pull cursor (extension, 6 Nov 2026: the phone
 * pushed 8734977f, backup tx 38521, at 02:37 carrying 02:03 times; the extension's incremental pull, 15 minutes of
 * overlap, never asked for it, and ~3.5M sats of coins were missing there).
 *
 * The toolbox pages a pull by `updated_at >= since`, but WITHOUT a cursor (since unset) it pages each entity in the
 * backup's own primary-key order (StorageKnex pagingOrder; the same in StorageIdb) with a plain offset. The backup's ids
 * only grow, so that order is the order rows reached the backup. This device's sync state keeps, per entity, the backup
 * ids of every row it has merged (its idMap). The first row this device never had is found by comparing the backup's
 * id at an offset with the matching id in the map, using one-row probes.
 *
 * Review of 8d59e33b (7 Nov 2026):
 *  - A probe skips the entities before the probed one with their REAL row counts, never a huge offset (a server's
 *    offset cap refuses those, and OFFSET 1e9 walks every row). Counts are found as the check goes (each entity's,
 *    in the toolbox's order) and kept for the next check, so an unchanged one costs two probes.
 *  - Only ids above the highest backup id already confirmed (`seen`, per entity) are compared: a row the backup purged
 *    (the monitor drops failed transactions after 5 days) leaves a hole in the map below that line, and is never read
 *    again.
 *  - The link tables (no ids of their own, paged by their composite key) are read from 0 only when their parent entity
 *    has rows this device never had (label links ← transactions, tag links ← outputs, certificate fields ←
 *    certificates); otherwise they are skipped.
 */

/** The toolbox's entity order (EntitySyncState.makeRequestSyncChunkArgs) and each entity's chunk key and id field. */
export const TAIL_ENTITIES = [
  { name: 'provenTx', key: 'provenTxs', id: 'provenTxId' },
  { name: 'outputBasket', key: 'outputBaskets', id: 'basketId' },
  { name: 'outputTag', key: 'outputTags', id: 'outputTagId' },
  { name: 'txLabel', key: 'txLabels', id: 'txLabelId' },
  { name: 'transaction', key: 'transactions', id: 'transactionId' },
  { name: 'output', key: 'outputs', id: 'outputId' },
  { name: 'txLabelMap', key: 'txLabelMaps', id: null, parent: 'transaction' },
  { name: 'outputTagMap', key: 'outputTagMaps', id: null, parent: 'output' },
  { name: 'certificate', key: 'certificates', id: 'certificateId' },
  { name: 'certificateField', key: 'certificateFields', id: null, parent: 'certificate' },
  { name: 'commission', key: 'commissions', id: 'commissionId' },
  { name: 'provenTxReq', key: 'provenTxReqs', id: 'provenTxReqId' },
] as const;

/** Above this offset a probe is not sent (the smallest backup profile caps offsets at 100k): the check fails. */
export const TAIL_OFFSET_CAP = 100_000;

export type GetSyncChunk = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** What a check keeps for the next one (in the sync state's full-pass mark). */
export type TailMemo = {
  /** Per entity with ids: the highest backup id confirmed merged; rows at or below it are never compared again. */
  seen?: Record<string, number>;
  /** Per entity: the backup's row count at the last check (the first guess this time). */
  counts?: Record<string, number>;
};

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

/** Per entity with ids: the highest backup id in the map (what a completed tail pass confirms). */
export const highestIds = (merged: Record<string, number[]>): Record<string, number> =>
  Object.fromEntries(
    TAIL_ENTITIES.filter((e) => e.id && merged[e.name]?.length).map((e) => [e.name, merged[e.name].at(-1)!]),
  );

/**
 * The tail: per entity, the offset of the first backup row this device never merged (its row count when none; a link
 * table at 0 when its parent has such rows). `tail` is null when nothing is missing. Throws when the backup refuses
 * a probe (or a count passes TAIL_OFFSET_CAP). `base` carries identityKey, fromStorageIdentityKey and
 * toStorageIdentityKey.
 */
export async function findTailOffsets(
  get: GetSyncChunk,
  base: Record<string, unknown>,
  merged: Record<string, number[]>,
  memo: TailMemo = {},
  log: (m: string) => void = (m) => console.warn(m),
): Promise<{ tail: { name: string; offset: number }[] | null; memo: Required<TailMemo>; skipped?: string }> {
  const counts: number[] = [];
  /** The row of entity `i` at `offset` (earlier entities skipped by their counts): its id, `true` (no id), or none. */
  const probe = async (i: number, offset: number): Promise<number | true | undefined> => {
    if (offset > TAIL_OFFSET_CAP) throw new PastCap();
    const offsets = TAIL_ENTITIES.map((e, j) => ({ name: e.name, offset: j < i ? counts[j] : j === i ? offset : 0 }));
    const chunk = await get({ ...base, since: undefined, maxItems: 1, maxRoughSize: 10_000_000, offsets });
    const e = TAIL_ENTITIES[i];
    const row = (chunk[e.key] as Record<string, unknown>[] | undefined)?.[0];
    if (!row) return undefined;
    if (!e.id) return true;
    const id = row[e.id];
    return typeof id === 'number' ? id : true;
  };
  const exists = async (i: number, k: number) => k >= 0 && (await probe(i, k)) !== undefined;
  /**
   * The backup's row count for entity `i`: the first offset with no row. Rows below `known` are known to exist. From
   * the last check's count as a guess: two probes when it is unchanged.
   */
  const countOf = async (i: number, guess: number, known = 0): Promise<number> => {
    let lo = known - 1; // highest offset known to have a row
    let hi: number; // an offset known to have none
    if (guess > known && (await exists(i, guess - 1))) {
      lo = guess - 1;
      hi = guess;
      while (await exists(i, hi)) {
        lo = hi;
        hi = Math.min(TAIL_OFFSET_CAP + 1, Math.max(hi + 1, hi * 2));
      }
    } else if (guess > known) {
      hi = guess - 1; // shrunk (rows purged): between known and the guess
    } else {
      hi = Math.max(known, 0);
      while (await exists(i, hi)) {
        lo = hi;
        hi = Math.min(TAIL_OFFSET_CAP + 1, Math.max(hi + 1, hi * 2));
      }
    }
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (await exists(i, mid)) lo = mid;
      else hi = mid;
    }
    return hi;
  };
  /** The first offset whose backup id is above `x` (ids only grow with the offset). */
  const firstAbove = async (i: number, x: number, guess: number): Promise<number> => {
    const above = async (k: number) => {
      const id = await probe(i, k);
      return id === undefined || (typeof id === 'number' && id > x);
    };
    if (guess > 0 && !(await above(guess - 1)) && (await above(guess))) return guess;
    let lo = -1; // not above
    let hi = Math.max(1, guess);
    while (!(await above(hi))) {
      lo = hi;
      hi = Math.min(TAIL_OFFSET_CAP + 1, hi * 2);
    }
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (await above(mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  };

  const starts = new Map<string, number>();
  const seen: Record<string, number> = { ...(memo.seen ?? {}) };
  const outCounts: Record<string, number> = { ...(memo.counts ?? {}) };
  let skipped: string | undefined;
  for (let i = 0; i < TAIL_ENTITIES.length && !skipped; i++) {
    const e = TAIL_ENTITIES[i];
    try {
      await checkEntity(i);
    } catch (err) {
      if (!(err instanceof PastCap)) throw err;
      // More rows than a probe may skip: this entity, and every one after it (their probes would skip it), are left to
      // the weekly full pass.
      skipped = e.name;
      log(
        `[tail-check] ${e.name} has more than ${TAIL_OFFSET_CAP} rows on the backup: it and the tables after it are left to the weekly full pass`,
      );
    }
  }
  async function checkEntity(i: number) {
    const e = TAIL_ENTITIES[i];
    const guess = memo.counts?.[e.name] ?? 0;
    if (!e.id) {
      const parentTail = starts.has(e.parent);
      counts[i] = await countOf(i, guess);
      if (parentTail && counts[i] > 0) starts.set(e.name, 0);
      outCounts[e.name] = counts[i];
      return;
    }
    const all = merged[e.name] ?? [];
    const x = seen[e.name];
    const below = x === undefined ? 0 : all.filter((id) => id <= x).length;
    const m = x === undefined ? all : all.filter((id) => id > x);
    const k0 = x === undefined ? 0 : await firstAbove(i, x, below);
    const n = m.length;
    let tail: number | undefined;
    if (n === 0) {
      if (await exists(i, k0)) tail = k0;
    } else if ((await probe(i, k0 + n - 1)) === m[n - 1]) {
      if (await exists(i, k0 + n)) tail = k0 + n;
    } else {
      let lo = k0;
      let hi = k0 + n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((await probe(i, mid)) === m[mid - k0]) lo = mid + 1;
        else hi = mid;
      }
      tail = lo;
    }
    counts[i] = tail === undefined ? k0 + n : await countOf(i, guess, tail);
    outCounts[e.name] = counts[i];
    if (tail === undefined) {
      if (n) seen[e.name] = m[n - 1];
    } else starts.set(e.name, tail);
  }
  const memoOut = { seen, counts: outCounts };
  // An entity too large to skip by offset: no tail pass at all (it would have to page past that entity too).
  if (skipped) return { tail: null, memo: memoOut, skipped };
  if (!starts.size) return { tail: null, memo: memoOut };
  return {
    tail: TAIL_ENTITIES.map((e, i) => ({ name: e.name, offset: starts.get(e.name) ?? counts[i] })),
    memo: memoOut,
  };
}

/** A probe would pass TAIL_OFFSET_CAP. */
class PastCap extends Error {}
