/**
 * The test harness's fake-indexeddb seek (src/testing/fastFakeIdb.ts) changes how fast a cursor finds its place, never
 * what it returns: every walk below gives the same records, in the same order, patched and not.
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { fakeIdbSeeks, installFastFakeIdb, uninstallFastFakeIdb } from './fastFakeIdb';

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('request failed'));
  });

type Row = { id: number; user: number; pair: [number, number]; name: string };

/** A deterministic generator (so a failure repeats). */
const rng = (seed: number) => () => {
  seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
  return seed / 4_294_967_296;
};

let dbn = 0;
async function storeWith(rows: Row[]) {
  const open = indexedDB.open(`fast-fake-idb-${++dbn}-${Date.now()}`, 1);
  open.onupgradeneeded = () => {
    const s = open.result.createObjectStore('rows', { keyPath: 'id' });
    s.createIndex('user', 'user'); // one key for many rows, as the toolbox's userId indexes
    s.createIndex('pair', 'pair'); // a compound key, as transactionId_vout_userId
    s.createIndex('name', 'name');
    for (const r of rows) s.put(r);
  };
  return req(open);
}

type Walk = {
  index?: 'user' | 'pair' | 'name';
  range?: IDBKeyRange | IDBValidKey;
  direction?: IDBCursorDirection;
  /** After the n-th record: advance(k), continue(key), or continuePrimaryKey(key, primaryKey). */
  jump?: { at: number; advance?: number; key?: IDBValidKey; primaryKey?: IDBValidKey };
};

async function walk(db: IDBDatabase, w: Walk): Promise<string> {
  const store = db.transaction('rows', 'readonly').objectStore('rows');
  const source = w.index ? store.index(w.index) : store;
  const out: string[] = [];
  let n = 0;
  try {
    let cursor = await req(source.openCursor(w.range ?? null, w.direction));
    while (cursor) {
      out.push(`${JSON.stringify(cursor.key)}>${JSON.stringify(cursor.primaryKey)}`);
      n++;
      const r = cursor.request;
      if (w.jump && n === w.jump.at) {
        if (w.jump.advance) cursor.advance(w.jump.advance);
        else if (w.jump.primaryKey !== undefined) cursor.continuePrimaryKey(w.jump.key!, w.jump.primaryKey);
        else cursor.continue(w.jump.key);
      } else cursor.continue();
      cursor = await req(r as IDBRequest<IDBCursorWithValue | null>);
    }
  } catch (e) {
    out.push(`threw ${(e as Error).name}`); // a jump the wrong way: the same refusal either way
  }
  return out.join(' ');
}

const walksFor = (rows: Row[], random: () => number): Walk[] => {
  const pick = () => rows[Math.floor(random() * rows.length)];
  const walks: Walk[] = [];
  const directions: IDBCursorDirection[] = ['next', 'prev', 'nextunique', 'prevunique'];
  for (const direction of directions) {
    for (const index of [undefined, 'user', 'pair', 'name'] as const) {
      const key = (r: Row): IDBValidKey =>
        index === 'user' ? r.user : index === 'pair' ? r.pair : index === 'name' ? r.name : r.id;
      const [a, b] = [key(pick()), key(pick())].sort((x, y) => indexedDB.cmp(x, y));
      const ranges: (IDBKeyRange | IDBValidKey | undefined)[] = [
        undefined,
        key(pick()),
        index === 'user' ? 9_999 : -5, // a key nothing has
        IDBKeyRange.lowerBound(a),
        IDBKeyRange.lowerBound(a, true),
        IDBKeyRange.upperBound(b),
        IDBKeyRange.upperBound(b, true),
        IDBKeyRange.bound(a, b),
        ...(indexedDB.cmp(a, b) === 0
          ? []
          : [IDBKeyRange.bound(a, b, true, true), IDBKeyRange.bound(a, b, false, true)]),
      ];
      for (const range of ranges) {
        walks.push({ index, range, direction });
        walks.push({ index, range, direction, jump: { at: 2, advance: 3 } });
        walks.push({ index, range, direction, jump: { at: 1, key: key(pick()) } });
        if (index && (direction === 'next' || direction === 'prev')) {
          const p = pick();
          walks.push({ index, range, direction, jump: { at: 1, key: key(p), primaryKey: p.id } });
        }
      }
    }
  }
  return walks;
};

describe('the test harness: fake-indexeddb with a real seek', () => {
  test('every cursor walk returns the same records in the same order, patched and not', async () => {
    const random = rng(20261114);
    const rows: Row[] = [];
    const ids = new Set<number>();
    while (rows.length < 240) {
      const id = Math.floor(random() * 5_000);
      if (ids.has(id)) continue;
      ids.add(id);
      rows.push({
        id,
        user: Math.floor(random() * 3), // long runs of one key
        pair: [Math.floor(random() * 40), Math.floor(random() * 4)],
        name: `n${Math.floor(random() * 60)}`,
      });
    }
    const db = await storeWith(rows);
    const walks = walksFor(rows, random);
    // As fake-indexeddb ships (another file in this process may have installed the patch: back on afterwards).
    const wasOn = await uninstallFastFakeIdb();
    try {
      // Inserts land in the same places: a store filled with the patch on holds every index in the same order.
      const order = (d: IDBDatabase) => {
        const raw = (
          d.transaction('rows', 'readonly').objectStore('rows') as unknown as {
            _rawObjectStore: {
              records: { records: { key: unknown }[] };
              rawIndexes: Map<string, { records: { records: { key: unknown; value: unknown }[] } }>;
            };
          }
        )._rawObjectStore;
        return JSON.stringify([
          raw.records.records.map((r) => r.key),
          ...[...raw.rawIndexes.entries()].map(([k, i]) => [k, i.records.records.map((r) => [r.key, r.value])]),
        ]);
      };
      const plainOrder = order(db);
      expect(await installFastFakeIdb()).toBe(true);
      const filledFast = await storeWith(rows);
      // Updates too (a put deletes the row's index entries and adds them again).
      const touch = async (d: IDBDatabase) => {
        const tx = d.transaction('rows', 'readwrite');
        for (const r of rows.slice(0, 60)) tx.objectStore('rows').put({ ...r, user: (r.user + 1) % 3 });
        await new Promise<void>((res, rej) => {
          tx.oncomplete = () => res();
          tx.onerror = () => rej(tx.error ?? new Error('put failed'));
        });
      };
      expect(order(filledFast)).toBe(plainOrder);
      await touch(filledFast);
      await uninstallFastFakeIdb();
      await touch(db);
      expect(order(filledFast)).toBe(order(db));
      filledFast.close();
      const plain: string[] = [];
      for (const w of walks) plain.push(await walk(db, w));
      expect(await installFastFakeIdb()).toBe(true);
      const fast: string[] = [];
      for (const w of walks) fast.push(await walk(db, w));
      expect(walks.length).toBeGreaterThan(400);
      expect(plain.filter((p) => p.length > 0 && !p.startsWith('threw')).length).toBeGreaterThan(300); // rows do come
      for (let i = 0; i < walks.length; i++)
        if (fast[i] !== plain[i])
          throw new Error(`walk ${i} ${JSON.stringify(walks[i])}:\n plain ${plain[i]}\n fast  ${fast[i]}`);
    } finally {
      if (!wasOn) await uninstallFastFakeIdb();
      db.close();
    }
  });

  test('a point lookup and each cursor step look at a few records, not at every record before them', async () => {
    const rows: Row[] = [];
    for (let i = 0; i < 4_000; i++) rows.push({ id: i, user: 1, pair: [i >> 2, i & 3], name: `n${i}` });
    const wasOn = await uninstallFastFakeIdb();
    await installFastFakeIdb();
    const db = await storeWith(rows); // opened with the patch on
    try {
      fakeIdbSeeks.compared = 0;
      // The last row by its compound key: a walk from record 0 would pass 3,999 records.
      expect(await walk(db, { index: 'pair', range: [999, 3] })).toBe('[999,3]>3999');
      expect(fakeIdbSeeks.compared).toBeLessThan(100);
      // 200 steps deep into an index where every row has the same key (the toolbox's paging by userId).
      fakeIdbSeeks.compared = 0;
      const store = db.transaction('rows', 'readonly').objectStore('rows');
      let cursor = await req(store.index('user').openCursor(1));
      cursor!.advance(3_700);
      cursor = await req(cursor!.request as IDBRequest<IDBCursorWithValue | null>);
      const before = fakeIdbSeeks.compared;
      for (let i = 0; i < 200; i++) {
        const r = cursor!.request;
        cursor!.continue();
        cursor = await req(r as IDBRequest<IDBCursorWithValue | null>);
      }
      expect(cursor!.primaryKey).toBe(3_900);
      expect(fakeIdbSeeks.compared - before).toBeLessThan(200 * 40); // about log2(4,000) twice per step, not 3,800
      // Finished transactions are dropped from the database's list (each new one scanned them all).
      const raw = (db as unknown as { _rawDatabase: { transactions: unknown[] } })._rawDatabase;
      for (let i = 0; i < 300; i++) await req(db.transaction('rows', 'readonly').objectStore('rows').get(i));
      expect(raw.transactions.length).toBeLessThan(5);
    } finally {
      if (!wasOn) await uninstallFastFakeIdb();
      db.close();
    }
  });
});
