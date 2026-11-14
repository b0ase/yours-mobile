/**
 * Test harness only: makes fake-indexeddb seek like a real IndexedDB.
 *
 * fake-indexeddb 6.0.0 keeps each store and index as one sorted array, and RecordStore.values(range) finds a range's
 * first record by walking from record 0. FDBCursor._iterate calls it for every cursor open AND every cursor step, and
 * then skips, one by one, the records at or before the cursor's position. So a point lookup through a cursor costs the
 * number of records before it, and a cursor walk over k records costs about k × that. A real IndexedDB seeks a B-tree:
 * both are O(log n). With thousands of rows the fake's cost swamps what a test means to measure (the full re-pull
 * benchmark, src/incident/fullRepull.test.ts: at 5,000 outputs, most of a pass was this walk).
 *
 * The patch: the first record is found by binary search, on the range's bound and on the cursor's own position (handed
 * over by a wrapper around _iterate). Only records the original loop would have skipped are skipped, and every check in
 * _iterate still runs on the records from there on, so the same records come in the same order
 * (src/testing/fastFakeIdb.test.ts compares the two on random stores).
 *
 * RecordStore.add walks too: a new index entry goes after the entries with the same key and a smaller primary key, found
 * one by one, so an insert into an index where every row has the same key (userId) passes every row. The patch finds
 * the same place by binary search.
 *
 * And a third, the same way: a database keeps every transaction it ever ran in one list and scans the whole list when
 * a transaction is created and again when one ends, so the T-th lookup costs T. The patch drops finished transactions
 * from the list before each scan (never a versionchange one: the upgrade checks look for the latest of those). Every
 * reader of the list only asks about transactions that are not finished, so nothing else changes. It takes effect for
 * databases opened after the patch is installed (each binds its scan when it is created).
 *
 * Everything is taken from the global `indexedDB` in use, at run time, so it patches the copy the tests really run on.
 * A fake-indexeddb whose internals have other names is left alone (the patch reports false).
 */

type Rec = { key: unknown; value: unknown };
type Range = { lower?: unknown; upper?: unknown; lowerOpen?: boolean; upperOpen?: boolean };
type RecordStore = {
  records: Rec[];
  values(range?: Range, direction?: 'next' | 'prev'): Iterable<Rec>;
};
type CursorLike = {
  source: { _rawIndex?: { records: RecordStore }; _rawObjectStore?: { records: RecordStore } };
  _position?: unknown;
  _objectStorePosition?: unknown;
};
type Hint = { records: RecordStore; position: unknown; storePosition: unknown; index: boolean };

const PATCHED = Symbol.for('bwx.fastFakeIdb');
/** Records looked at while finding where a walk starts (for the tests: a seek is a few, not thousands). */
export const fakeIdbSeeks = { compared: 0 };

let hint: Hint | undefined;

/** The first index in [0, n) where `after(i)` holds (it holds from there on), else n. */
const firstWhere = (n: number, after: (i: number) => boolean): number => {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    fakeIdbSeeks.compared++;
    if (after(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
};

function fastValues(this: RecordStore, cmp: (a: unknown, b: unknown) => number, range?: Range, direction = 'next') {
  const h = hint && hint.records === this && hint.position !== undefined ? hint : undefined;
  const upward = direction === 'next';
  return {
    [Symbol.iterator]: () => {
      const recs = this.records;
      let i: number;
      if (upward) {
        i = 0;
        if (range?.lower !== undefined) {
          const { lower, lowerOpen } = range;
          // As the original: the first record whose key is past the bound (or at it, when the bound is closed).
          i = firstWhere(recs.length, (m) => {
            const c = cmp(recs[m].key, lower);
            return c === 1 || (c === 0 && !lowerOpen);
          });
        }
        if (h) {
          // _iterate skips every record at or before the cursor's position: (key, primary key) for an index, where a
          // key repeats; the key alone for a store.
          const past = firstWhere(recs.length, (m) => {
            const c = cmp(recs[m].key, h.position);
            if (c !== 0 || !h.index) return c === 1;
            return h.storePosition !== undefined && cmp(recs[m].value, h.storePosition) === 1;
          });
          // An index cursor with no primary-key position skips nothing by it (the original compares and continues).
          if (!h.index || h.storePosition !== undefined) i = Math.max(i, past);
        }
      } else {
        i = recs.length - 1;
        if (range?.upper !== undefined) {
          const { upper, upperOpen } = range;
          // The last record whose key is before the bound (or at it, when closed): one before the first that is past it.
          i =
            firstWhere(recs.length, (m) => {
              const c = cmp(recs[m].key, upper);
              return c === 1 || (c === 0 && !!upperOpen);
            }) - 1;
        }
        if (h && (!h.index || h.storePosition !== undefined)) {
          // The last record strictly before the cursor's position.
          const before =
            firstWhere(recs.length, (m) => {
              const c = cmp(recs[m].key, h.position);
              if (c !== 0 || !h.index) return c !== -1;
              return cmp(recs[m].value, h.storePosition) !== -1;
            }) - 1;
          i = Math.min(i, before);
        }
      }
      return {
        // The original's own step, unchanged: the far bound is still checked on every record.
        next: (): IteratorResult<Rec> => {
          let done: boolean;
          let value: Rec | undefined;
          if (upward) {
            value = this.records[i];
            done = i >= this.records.length;
            i += 1;
            if (!done && range !== undefined && range.upper !== undefined) {
              const c = cmp(value.key, range.upper);
              done = c === 1 || (c === 0 && !!range.upperOpen);
              if (done) value = undefined;
            }
          } else {
            value = this.records[i];
            done = i < 0;
            i -= 1;
            if (!done && range !== undefined && range.lower !== undefined) {
              const c = cmp(value.key, range.lower);
              done = c === -1 || (c === 0 && !!range.lowerOpen);
              if (done) value = undefined;
            }
          }
          return { done, value } as IteratorResult<Rec>;
        },
      };
    },
  };
}

/** RecordStore.add: the same place as the original (after equal keys with a smaller value), found by binary search. */
function fastAdd(this: RecordStore, cmp: (a: unknown, b: unknown) => number, rec: Rec) {
  const recs = this.records;
  // The first record whose key is not before the new one (the original's getIndexByKeyGTE; none: the end).
  let i = firstWhere(recs.length, (m) => cmp(recs[m].key, rec.key) !== -1);
  if (i < recs.length && cmp(recs[i].key, rec.key) === 0) {
    // Among the records with this key: before the first whose value is not smaller, else after them all.
    const from = i;
    const run = firstWhere(recs.length - from, (m) => cmp(recs[from + m].key, rec.key) === 1);
    i = from + firstWhere(run, (m) => cmp(recs[from + m].value, rec.value) !== -1);
  }
  recs.splice(i, 0, rec);
}

const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('fake-indexeddb request failed'));
  });

type Proto = Record<string | symbol, unknown>;
type Protos = { recordProto: Proto; cursorProto: Proto; databaseProto: Proto };
type Originals = { values: unknown; add: unknown; iterate: unknown; processTransactions: unknown };
type RawDatabase = { transactions: { _state?: string; mode?: string }[] };

/** The RecordStore and FDBCursor prototypes behind the global `indexedDB`, found on a throwaway database. */
async function protos(idb: IDBFactory): Promise<Protos | undefined> {
  const name = `bwx-fast-fake-idb-probe-${Math.random().toString(36).slice(2)}`;
  const open = idb.open(name, 1);
  open.onupgradeneeded = () => {
    const s = open.result.createObjectStore('s', { keyPath: 'id' });
    s.createIndex('k', 'k');
    s.put({ id: 1, k: 1 });
  };
  const db = await request(open);
  try {
    const tx = db.transaction('s', 'readonly');
    const store = tx.objectStore('s') as unknown as IDBObjectStore & { _rawObjectStore?: { records?: RecordStore } };
    const cursor = await request(store.openCursor());
    const records = store._rawObjectStore?.records;
    const raw = (db as unknown as { _rawDatabase?: RawDatabase })._rawDatabase;
    const databaseProto = raw && (Object.getPrototypeOf(raw) as Proto);
    const recordProto = records && (Object.getPrototypeOf(records) as Record<string | symbol, unknown>);
    let cursorProto = cursor && (Object.getPrototypeOf(cursor) as Record<string | symbol, unknown> | null);
    while (cursorProto && !Object.prototype.hasOwnProperty.call(cursorProto, '_iterate'))
      cursorProto = Object.getPrototypeOf(cursorProto) as Record<string | symbol, unknown> | null;
    if (
      !recordProto ||
      !cursorProto ||
      typeof recordProto.values !== 'function' ||
      typeof recordProto.add !== 'function' ||
      typeof cursorProto._iterate !== 'function' ||
      !Array.isArray(records.records) ||
      !databaseProto ||
      typeof databaseProto.processTransactions !== 'function' ||
      !Array.isArray(raw.transactions)
    )
      return undefined;
    return { recordProto, cursorProto, databaseProto };
  } finally {
    db.close();
    idb.deleteDatabase(name);
  }
}

/**
 * Patch the fake-indexeddb behind the global `indexedDB` (see the header). Idempotent, and for the whole process (`bun
 * test` runs every file in one): nothing needs to take it off. False when this isn't a fake-indexeddb with the internals
 * the patch knows (left as it is).
 */
export async function installFastFakeIdb(): Promise<boolean> {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  const p = idb && (await protos(idb));
  if (!idb || !p) return false;
  const { recordProto, cursorProto, databaseProto } = p;
  if (recordProto[PATCHED]) return true;
  const cmp = (a: unknown, b: unknown) => idb.cmp(a as IDBValidKey, b as IDBValidKey);
  const iterate = cursorProto._iterate as (this: CursorLike, ...a: unknown[]) => unknown;
  const processTransactions = databaseProto.processTransactions as (this: RawDatabase) => void;
  recordProto[PATCHED] = {
    values: recordProto.values,
    add: recordProto.add,
    iterate,
    processTransactions,
  } satisfies Originals;
  recordProto.add = function (this: RecordStore, rec: Rec) {
    fastAdd.call(this, cmp, rec);
  };
  databaseProto.processTransactions = function (this: RawDatabase) {
    const list = this.transactions;
    let kept = 0;
    for (const t of list) if (t._state !== 'finished' || t.mode === 'versionchange') list[kept++] = t;
    list.length = kept;
    processTransactions.call(this);
  };
  recordProto.values = function (this: RecordStore, range?: Range, direction?: 'next' | 'prev') {
    return fastValues.call(this, cmp, range, direction);
  };
  cursorProto._iterate = function (this: CursorLike, ...a: unknown[]) {
    const index = this.source?._rawIndex?.records;
    const own = index ?? this.source?._rawObjectStore?.records;
    const before = hint;
    hint = own
      ? { records: own, position: this._position, storePosition: this._objectStorePosition, index: !!index }
      : undefined;
    try {
      return iterate.apply(this, a);
    } finally {
      hint = before;
    }
  };
  return true;
}

/** Tests of the patch itself: fake-indexeddb as it ships again. True when the patch was on. */
export async function uninstallFastFakeIdb(): Promise<boolean> {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  const p = idb && (await protos(idb));
  const was = p?.recordProto[PATCHED] as Originals | undefined;
  if (!p || !was) return false;
  p.recordProto.values = was.values;
  p.recordProto.add = was.add;
  p.cursorProto._iterate = was.iterate;
  p.databaseProto.processTransactions = was.processTransactions;
  delete p.recordProto[PATCHED];
  return true;
}
