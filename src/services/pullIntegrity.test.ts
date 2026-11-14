/**
 * The list of payments waiting for their coins (services/pullIntegrity.ts): what goes on it, where it stops, and that
 * keeping it costs work in step with the page, not with the square of the list (cost review, 14 Nov 2026).
 *
 * A stand-in store holding one sync state row; the toolbox's own EntitySyncState writes it.
 */
import { describe, expect, test } from 'bun:test';
import { markOf, type AwaitOutputs, type FullPassMark, type SyncStateRow } from './fullPass';
import { MAX_AWAITING, afterPull, noteAwaiting, type IntegrityStore } from './pullIntegrity';

const NOW = 1_794_000_000_000;
const DAY = 24 * 3_600_000;

function storeWith(mark: FullPassMark, txMap: Record<string, number> = {}, withOutputs: number[] = []) {
  const row: SyncStateRow & Record<string, unknown> = {
    syncStateId: 7,
    userId: 1,
    storageIdentityKey: 'backup',
    storageName: 'backup',
    status: 'unknown',
    init: true,
    refNum: 'ref',
    created_at: new Date(NOW - DAY),
    updated_at: new Date(NOW - DAY),
    when: new Date(NOW - 60_000),
    syncMap: JSON.stringify({
      transaction: { entityName: 'transaction', idMap: txMap, count: 0 },
      output: { entityName: 'output', idMap: {}, count: 0 },
      bwxFullPass: mark,
    }),
  };
  const store = {
    findUsers: async () => [{ userId: 1 }],
    findSyncStates: async () => [{ ...row }],
    updateSyncState: async (_id: number, update: Record<string, unknown>) => {
      Object.assign(row, update);
      return 1;
    },
    findTransactions: async () => [],
    findOutputs: async () => withOutputs.map((transactionId) => ({ transactionId, vout: 0 })),
  };
  const read = async () => (await store.findSyncStates())[0] as SyncStateRow;
  return { store: store as unknown as IntegrityStore, read };
}

/** How many times `fn` lists an object's keys (Object.keys), whatever it lists. */
async function keyListings(fn: () => Promise<unknown>): Promise<number> {
  const keys = Object.keys;
  let n = 0;
  Object.keys = ((o: object) => {
    n++;
    return keys(o);
  }) as typeof Object.keys;
  try {
    await fn();
  } finally {
    Object.keys = keys;
  }
  return n;
}

const entries = (n: number, from = 1): Record<string, AwaitOutputs> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [String(from + i), { at: NOW - DAY }]));

describe('payments noted for the coin check after a page (noteAwaiting)', () => {
  test('new ones are noted once; ones already waiting or known to have no coins are left as they are', async () => {
    const s = storeWith({ awaitOutputs: { '5': { at: 111, tries: 1 } }, emptyOk: { '6': Math.floor(NOW / DAY) } });
    await noteAwaiting(s.store, await s.read(), [4, 5, 6, 7, 7, 4], NOW);
    expect(markOf(await s.read()).awaitOutputs).toEqual({
      '4': { at: NOW },
      '5': { at: 111, tries: 1 },
      '7': { at: NOW },
    });
  });

  test('the list stops at MAX_AWAITING: the first new ones in the page fill it, the rest are left out', async () => {
    const had = entries(MAX_AWAITING - 3, 100_000);
    const s = storeWith({ awaitOutputs: had });
    await noteAwaiting(s.store, await s.read(), [9, 100_000, 8, 8, 7, 6, 5], NOW);
    const noted = markOf(await s.read()).awaitOutputs!;
    expect(Object.keys(noted).length).toBe(MAX_AWAITING);
    expect(['9', '8', '7', '6', '5'].map((k) => k in noted)).toEqual([true, true, true, false, false]);
    expect(noted['100000']).toEqual({ at: NOW - DAY }); // one already waiting: untouched, and it took no place
    // A full list takes nothing more, and nothing is written.
    const before = String((await s.read()).syncMap);
    await noteAwaiting(s.store, await s.read(), [1, 2, 3], NOW);
    expect(String((await s.read()).syncMap)).toBe(before);
  });

  test("a page of new payments lists the waiting list's keys a fixed number of times, not once per payment", async () => {
    // Before: Object.keys of the whole list for every id on the page (3,000 ids on a list growing to 4,000: about ten
    // million keys listed for one page).
    const s = storeWith({ awaitOutputs: entries(1_000, 100_000) });
    const ids = Array.from({ length: 3_000 }, (_, i) => i + 1);
    const row = await s.read();
    const listings = await keyListings(() => noteAwaiting(s.store, row, ids, NOW));
    expect(listings).toBeLessThan(50);
    expect(Object.keys(markOf(await s.read()).awaitOutputs!).length).toBe(4_000);
  });
});

describe('the daily scan for payments with no coins at all (afterPull)', () => {
  test('it notes them up to MAX_AWAITING, in the same order, listing the keys a fixed number of times', async () => {
    // 9,000 payments from the backup (backup id → device id); the device holds coins for every third.
    const txMap: Record<string, number> = {};
    for (let i = 1; i <= 9_000; i++) txMap[String(i)] = 50_000 + i;
    const withOutputs = Object.values(txMap).filter((id) => id % 3 === 0);
    const had: Record<string, AwaitOutputs> = {
      '2': { at: 5, nextAt: NOW + DAY }, // in the map, already waiting
      '900001': { at: 6, nextAt: NOW + DAY }, // not in the map
    };
    const emptyOk = { '4': Math.floor(NOW / DAY), '5': Math.floor(NOW / DAY) };
    const s = storeWith({ awaitOutputs: had, emptyOk }, txMap, withOutputs);
    // What the scan should note: the map in its own order, skipping what has coins, waits already or is known empty,
    // until the list is full.
    const expected = new Set(Object.keys(had));
    const hasCoins = new Set(withOutputs);
    for (const [backupId, deviceId] of Object.entries(txMap)) {
      if (expected.size >= MAX_AWAITING) break;
      if (hasCoins.has(deviceId) || expected.has(backupId) || backupId in emptyOk) continue;
      expected.add(backupId);
    }
    expect(expected.size).toBe(MAX_AWAITING); // the scan does fill the list here
    const listings = await keyListings(() =>
      afterPull({
        manager: { runAsSync: (fn) => fn(undefined) },
        store: s.store,
        identityKey: 'me',
        readerSik: 'backup',
        backupOutputs: async () => [],
        now: NOW,
        limit: 0, // the scan only: nothing checked against the backup in this run
        log: () => undefined,
      }),
    );
    const mark = markOf(await s.read());
    expect(new Set(Object.keys(mark.awaitOutputs!))).toEqual(expected);
    expect(mark.awaitOutputs!['2']).toEqual({ at: 5, nextAt: NOW + DAY });
    expect(mark.scanAt).toBe(NOW);
    expect(listings).toBeLessThan(50); // before: once per payment in the map (thousands, each over the whole list)
  });
});
