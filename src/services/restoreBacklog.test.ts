/**
 * The post-restore backlog (task 71 review, A1): payments skip the push before broadcast only while a fresh restore's
 * copy or first pass runs, keyed to an explicit restore mark and capped at RESTORE_BACKLOG_MS. The weekly full pass, the
 * daily deep pull, a heal, an interrupted pull or an empty cursor never count on their own.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  asRestore,
  clearRestoreMark,
  markRestore,
  RESTORE_BACKLOG_MS,
  restoreBacklog,
  restoreCaughtUp,
  restoreMarked,
  STUCK_PASS_MS,
  type FullPassMark,
  type SyncStateRow,
} from './fullPass';
import { createChangeWriteAhead, onBroadcast } from './changeWriteAhead';
import { createInFlight, type InFlight } from './pushView';

const T0 = 1_800_000_000_000;
/** This device store's sync state for the backup: the cursor, one entity's offset, and our mark. */
const row = (o: { when?: number; count?: number; mark?: FullPassMark } = {}): SyncStateRow => ({
  syncStateId: 1,
  when: o.when === undefined ? undefined : new Date(o.when),
  syncMap: JSON.stringify({ transaction: { count: o.count ?? 0 }, bwxFullPass: o.mark ?? {} }),
});

afterEach(() => clearRestoreMark());

describe('passes that are not a restore never count as the backlog', () => {
  test('the weekly full pass under way (cursor empty, offsets moving)', () => {
    expect(restoreBacklog(row({ count: 40, mark: { startedAt: T0 } }), T0 + 60_000)).toBe(false);
  });
  test('the daily deep pull under way', () => {
    expect(restoreBacklog(row({ when: T0, count: 12, mark: { deepStartedAt: T0 } }), T0 + 60_000)).toBe(false);
  });
  test('a heal pass, and an interrupted incremental pull', () => {
    expect(restoreBacklog(row({ when: T0, count: 3, mark: { healStartedAt: T0 } }), T0)).toBe(false);
    expect(restoreBacklog(row({ when: T0, count: 3 }), T0)).toBe(false);
  });
  test('a cursor left empty (an empty backup pulled to the end), for good', () => {
    const r = row({ when: undefined, count: 0 });
    expect(restoreBacklog(r, T0)).toBe(false);
    expect(restoreBacklog(r, T0 + 30 * 24 * 3_600_000)).toBe(false);
  });
  test("a store's first pass reported stuck", () => {
    markRestore(T0);
    expect(restoreBacklog(row({ count: 7, mark: { stuckMs: STUCK_PASS_MS } }), T0 + 60_000)).toBe(false);
  });
});

describe('a real restore', () => {
  test('its copy skips the push while it runs; a copy that went through ends the backlog', async () => {
    let during: boolean | undefined;
    await asRestore(async () => {
      during = restoreBacklog(row({ count: 5 }));
    });
    expect(during).toBe(true);
    expect(restoreMarked()).toBe(false);
    expect(restoreBacklog(row({ count: 5 }))).toBe(false);
  });

  test('an interrupted copy: its first pass carried on by the pulls still counts, until they catch up', async () => {
    await asRestore(async () => {
      throw new Error('worker interrupted');
    }).catch(() => undefined);
    const now = Date.now();
    expect(restoreBacklog(row({ count: 9 }), now + 60_000)).toBe(true);
    restoreCaughtUp();
    expect(restoreBacklog(row({ count: 9 }), now + 60_000)).toBe(false);
  });

  test('a pull that caught up after the restore started (pullOkAt) ends it', () => {
    markRestore(T0);
    expect(restoreBacklog(row({ count: 2, mark: { pullOkAt: T0 + 5 } }), T0 + 10)).toBe(false);
    expect(restoreMarked()).toBe(false);
  });

  test('one latch per open: marks after the cap stay off (a store with no sync row re-marks every pull) until reopen', async () => {
    markRestore(T0);
    expect(restoreBacklog(undefined, T0 + 1)).toBe(true);
    // Every later pull of a store still without a row marks again; past the cap none of them take effect.
    const seen: boolean[] = [];
    for (let k = 0; k < 5; k++) {
      const at = T0 + RESTORE_BACKLOG_MS + k * 60_000;
      markRestore(at);
      seen.push(restoreBacklog(undefined, at));
    }
    expect(seen).toEqual([false, false, false, false, false]);
    // An asRestore that keeps failing re-arms nothing either (Date.now() here is long past T0 + cap).
    for (let k = 0; k < 3; k++) await asRestore(() => Promise.reject(new Error('copy failed'))).catch(() => undefined);
    expect(restoreMarked()).toBe(false);
    // A new open (the wallet's close clears the latch): a mark takes effect again.
    clearRestoreMark();
    markRestore(T0 + 10 * RESTORE_BACKLOG_MS);
    expect(restoreBacklog(undefined, T0 + 10 * RESTORE_BACKLOG_MS + 1)).toBe(true);
  });

  test('a re-mark inside the cap counts from the first start (never extends it)', () => {
    markRestore(T0);
    restoreCaughtUp(); // first pass caught up
    markRestore(T0 + RESTORE_BACKLOG_MS - 10); // e.g. a second restore copy in the same open
    expect(restoreBacklog(undefined, T0 + RESTORE_BACKLOG_MS - 5)).toBe(true);
    expect(restoreBacklog(undefined, T0 + RESTORE_BACKLOG_MS)).toBe(false);
  });

  test('the skip ends at the cap, whatever the pass is doing, and a second mark never extends it', () => {
    markRestore(T0);
    markRestore(T0 + RESTORE_BACKLOG_MS - 1); // not moved later
    const r = row({ count: 30 });
    expect(restoreBacklog(r, T0 + RESTORE_BACKLOG_MS - 1)).toBe(true);
    expect(restoreBacklog(r, T0 + RESTORE_BACKLOG_MS)).toBe(false);
    expect(restoreBacklog(r, T0 + RESTORE_BACKLOG_MS + 1)).toBe(false);
  });
});

/** The write-ahead as initWallet wires it, with the backlog check reading one row. */
function wired(r: SyncStateRow) {
  const events: string[] = [];
  const storage = {
    writerLocks: [] as unknown[],
    spLocks: [] as unknown[],
    getActive: () => ({ findProvenTxReqs: async () => [] }),
    getAuth: async () => ({ identityKey: 'id', userId: 1, isActive: true }),
    async syncToWriter(_a: unknown, writer: object) {
      events.push('push');
      const v = writer as Record<string, (...a: unknown[]) => Promise<unknown>>;
      await v.makeAvailable();
      await v.processSyncChunk({}, { transactions: [] });
    },
  };
  const backup = { makeAvailable: async () => ({}), processSyncChunk: async () => ({ done: true }) };
  const inFlights = new Map<object, InFlight>();
  const wa = createChangeWriteAhead({
    applies: () => true,
    backups: () => [{ storage: backup }],
    storage: storage as never,
    inFlightFor: (b) => {
      let f = inFlights.get(b);
      if (!f) inFlights.set(b, (f = createInFlight()));
      return f;
    },
    pushNow: async () => ({ ok: true, pulled: false, pushed: true }),
    backlog: async () => restoreMarked() && restoreBacklog(r),
    retryTimer: { set: () => 1, clear: () => undefined },
    log: () => undefined,
  });
  const services = {
    postBeef: async (_b: unknown, txids: string[]) => {
      events.push(`post ${txids.length}`);
      return [{ status: 'success' }];
    },
  };
  onBroadcast(services, wa);
  return { wa, events, services };
}

describe('the push before a broadcast, with the backlog check wired', () => {
  const TX = 'd'.repeat(64);
  test('the weekly full pass does not skip the push', async () => {
    const h = wired(row({ count: 40, mark: { startedAt: Date.now() } }));
    h.wa.arm([TX]);
    await h.services.postBeef({}, [TX]);
    expect(h.events).toEqual(['push', 'post 1']);
  });
  test('during a restore copy the push is skipped and the payment flagged', async () => {
    const h = wired(row({ count: 40 }));
    h.wa.arm([TX]);
    await asRestore(() => h.services.postBeef({}, [TX]));
    expect(h.events).toEqual(['post 1']);
    expect(h.wa.count()).toBe(1);
  });
});
