/**
 * Own payments go first (owner's seal, 7 Nov 2026, doc dbb9beec): the seal's one createAction took ~25 s, ten seconds
 * after the app opened, while the open-time device sync held the toolbox's single first-come-first-served storage queue.
 *
 * The rule (review of perf/phone-seal-speed, 7 Nov 2026): a PUSH never yields mid-cycle. Its checkpoint is a `since`
 * plus a per-entity offset over this device's rows filtered by updated_at, so a payment that writes during a paused
 * cycle (it spends old coin X: X.updated_at moves inside the filtered set) shifts the offsets: the resumed scan skips a
 * row, and `when` then moves past X's update, so the backup keeps X spendable for good. Own payments go first only
 * BEFORE a push cycle starts or BETWEEN backups. The pull's page yield stays (fullPass afterPage: why it is safe there).
 *
 * The fakes model the real getSyncChunk: rows keyed by id, `updated_at >= since`, ordered by id, skip `offset`; the
 * backup commits each page with its checkpoint (since, offset, when) and refuses a page whose checkpoint doesn't match
 * (requireMatchingCheckpoint); an empty page ends the cycle (since ← when, offset ← 0). The storage queue is the
 * toolbox's lock algorithm; the push loop is syncToWriter's; the push itself is the real makeBackupPush. Virtual time.
 */
import { describe, expect, test } from 'bun:test';
import { createOwnPaymentGate } from './ownPayments';
import { PUSH_CALL_MS, SETTLE_WAIT_MS, createInFlight, makeBackupPush, pushView } from './pushView';
import { BACKOFF_MS, createDeviceSync } from './deviceSync';
import { afterPage, beforePage, paymentYields, withFullPassMode } from './fullPass';

// ── virtual time ─────────────────────────────────────────────────────────────
const vclock = () => {
  let now = 0;
  let nextId = 1;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  const setTimer = (fn: () => void, ms: number) => {
    const id = nextId++;
    timers.push({ at: now + Math.max(0, ms), fn, id });
    return id;
  };
  const clearTimer = (id: unknown) => {
    const i = timers.findIndex((t) => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  };
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  return {
    now: () => now,
    setTimer,
    clearTimer,
    sleep: (ms: number) => new Promise<void>((r) => setTimer(r, ms)),
    async runUntil(until: number) {
      await settle();
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const t = timers[0];
        if (!t || t.at > until) break;
        timers.shift();
        now = t.at;
        t.fn();
        await settle();
      }
      if (now < until) now = until;
    },
  };
};
type Clock = ReturnType<typeof vclock>;

// ── this device's store: the real getSyncChunk shape ─────────────────────────
type Row = { id: number; updated_at: number; spendable: boolean };
/** Rows 1..n, row i last changed at 10·i − 1000, before the test's clock starts at 0 (row 1 is the oldest coin). */
const deviceStore = (n: number) => {
  const rows = new Map<number, Row>();
  for (let i = 1; i <= n; i++) rows.set(i, { id: i, updated_at: 10 * i - 1000, spendable: true });
  let nextId = n + 1;
  return {
    rows,
    getSyncChunk(args: { since: number; offset: number }, limit: number): Row[] {
      return [...rows.values()]
        .filter((r) => r.updated_at >= args.since)
        .sort((a, b) => a.id - b.id)
        .slice(args.offset, args.offset + limit)
        .map((r) => ({ ...r }));
    },
    /** A payment: spends old coin `id` (an UPDATE of an existing low-id row), then inserts its change. */
    spend(id: number, at: number) {
      const x = rows.get(id)!;
      rows.set(id, { ...x, spendable: false, updated_at: at });
      const change = nextId++;
      rows.set(change, { id: change, updated_at: at + 1, spendable: true });
      return change;
    },
  };
};

// ── the backup: page + checkpoint commit together ────────────────────────────
/** Already holds rows 1-4 from an earlier cycle (its checkpoint: since −950, row 5's time), so a cycle scans rows 5.. */
const backupStore = (c: Clock, o: { pageMs: number; answerLate?: Map<number, number> }) => {
  const rows = new Map<number, Row>();
  for (let i = 1; i <= 4; i++) rows.set(i, { id: i, updated_at: 10 * i - 1000, spendable: true });
  const received = new Map<number, number>(); // id+version → times it arrived
  let ckpt = { since: -950, offset: 0, when: -950 };
  let calls = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  return {
    rows,
    received,
    maxConcurrent: () => maxConcurrent,
    ckpt: () => ckpt,
    writer: {
      async makeAvailable() {
        return {};
      },
      async getSyncCheckpoint() {
        return { since: ckpt.since, offset: ckpt.offset };
      },
      async processSyncChunk(args: { since: number; offset: number }, chunk: { rows: Row[] }) {
        const n = calls++;
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        try {
          await c.sleep(o.pageMs);
          if (args.since !== ckpt.since || args.offset !== ckpt.offset) throw new Error('checkpoint changed');
          for (const r of chunk.rows) {
            const have = rows.get(r.id);
            if (!have || have.updated_at <= r.updated_at) rows.set(r.id, { ...r });
            const k = r.id * 1e6 + r.updated_at;
            received.set(k, (received.get(k) ?? 0) + 1);
          }
          if (!chunk.rows.length) ckpt = { since: ckpt.when, offset: 0, when: ckpt.when };
          else
            ckpt = {
              since: ckpt.since,
              offset: ckpt.offset + chunk.rows.length,
              when: Math.max(ckpt.when, ...chunk.rows.map((r) => r.updated_at)),
            };
          // Committed. A late answer: the client's deadline may already have given up on it.
          const late = o.answerLate?.get(n);
          if (late) await c.sleep(late);
          return { done: chunk.rows.length === 0 };
        } finally {
          concurrent--;
        }
      },
    },
  };
};

// ── the toolbox's lock queue and syncToWriter loop ───────────────────────────
const fakeManager = (c: Clock, device: ReturnType<typeof deviceStore>, pageSize: number, readMs: number) => {
  const readerLocks: (() => void)[] = [];
  const writerLocks: (() => void)[] = [];
  const syncLocks: (() => void)[] = [];
  const getLock = async (q: (() => void)[]) => {
    let resolveNew = () => {};
    const p = new Promise<void>((r) => {
      resolveNew = r;
      q.push(r);
    });
    if (q.length === 1) resolveNew();
    await p;
  };
  const release = (q: (() => void)[]) => {
    q.shift();
    if (q.length > 0) q[0]();
  };
  const runAsWriter = async <T>(fn: () => Promise<T>) => {
    await getLock(readerLocks);
    await getLock(writerLocks);
    try {
      return await fn();
    } finally {
      release(writerLocks);
      release(readerLocks);
    }
  };
  const runAsSync = async <T>(fn: () => Promise<T>) => {
    await getLock(readerLocks);
    await getLock(writerLocks);
    await getLock(syncLocks);
    try {
      return await fn();
    } finally {
      release(syncLocks);
      release(writerLocks);
      release(readerLocks);
    }
  };
  type Writer = ReturnType<typeof backupStore>['writer'];
  const authCalls: unknown[] = [];
  const storage = {
    async getAuth(mustBeActive?: boolean) {
      authCalls.push(mustBeActive);
      return { identityKey: 'id', userId: 1 };
    },
    syncToWriter: (_auth: unknown, writer: Writer) =>
      runAsSync(async () => {
        await writer.makeAvailable();
        let args = await writer.getSyncCheckpoint();
        for (;;) {
          await c.sleep(readMs); // getSyncChunk on this device
          const r = await writer.processSyncChunk(args, { rows: device.getSyncChunk(args, pageSize) });
          if (r.done) break;
          args = await writer.getSyncCheckpoint();
        }
      }),
  };
  return { runAsWriter, storage, authCalls };
};

/** The removed rule, kept to show what it broke: answer a committed page as the last when a payment waits. */
const midCycleYield = <W extends ReturnType<typeof backupStore>['writer']>(
  w: W,
  waiting: () => boolean,
  onYield: () => void,
): W => ({
  ...w,
  makeAvailable: () => w.makeAvailable(),
  getSyncCheckpoint: () => w.getSyncCheckpoint(),
  processSyncChunk: async (args, chunk) => {
    const r = await w.processSyncChunk(args, chunk);
    if (r.done || !waiting()) return r;
    onYield();
    return { ...r, done: true };
  },
});

const rig = (o: { pageMs?: number; answerLate?: Map<number, number>; oldRule?: boolean; rows?: number } = {}) => {
  const c = vclock();
  const gate = createOwnPaymentGate();
  const device = deviceStore(o.rows ?? 12);
  const mgr = fakeManager(c, device, 2, 50);
  const backup = backupStore(c, { pageMs: o.pageMs ?? 1_000, answerLate: o.answerLate });
  const inFlight = new WeakMap<object, ReturnType<typeof createInFlight>>();
  const timers = { setTimer: c.setTimer, clearTimer: c.clearTimer };
  const log: string[] = [];
  const newRulePush = makeBackupPush({
    storage: mgr.storage as never,
    backups: () => [{ storage: backup.writer }],
    waiting: gate.waiting,
    inFlightFor: (s) => {
      let f = inFlight.get(s);
      if (!f) inFlight.set(s, (f = createInFlight(timers)));
      return f;
    },
    ...timers,
  });
  const oldRulePush = async () => {
    let yielded = false;
    await mgr.storage.syncToWriter(
      {},
      midCycleYield(backup.writer, gate.waiting, () => (yielded = true)),
    );
    return yielded ? ('yielded' as const) : undefined;
  };
  const sync = createDeviceSync({
    applies: () => true,
    ensureBackup: async () => true,
    pull: async () => undefined,
    push: o.oldRule ? oldRulePush : newRulePush,
    yieldTo: gate,
    ...timers,
    now: c.now,
    log: (...a) => void log.push(a.map(String).join(' ')),
  });
  /** An own payment spending old coin `id`: the gate first (as the background's createAction does), then the queue. */
  const pay = async (id: number, holdMs = 300) => {
    const end = gate.begin();
    const askedAt = c.now();
    try {
      return await mgr.runAsWriter(async () => {
        const waited = c.now() - askedAt;
        device.spend(id, c.now());
        await c.sleep(holdMs);
        return waited;
      });
    } finally {
      end();
      sync.changed(); // as notifyOnWalletChanges does after every createAction
    }
  };
  /** Does the backup hold exactly what this device holds (every row, its latest version)? */
  const inStep = () =>
    [...device.rows.values()].every((r) => {
      const b = backup.rows.get(r.id);
      return b && b.spendable === r.spendable && b.updated_at === r.updated_at;
    });
  return { c, gate, device, mgr, backup, sync, pay, inStep, log };
};

describe('push: own payments never pause a cycle (review 7 Nov 2026, HIGH)', () => {
  test('(a) regression: the old mid-cycle yield loses the spend of old coin X; the backup keeps it spendable', async () => {
    const { c, sync, pay, backup, inStep } = rig({ oldRule: true });
    void sync.syncNow();
    await c.runUntil(1_500); // second page in flight
    void pay(1); // spends row 1: it enters the cycle's scan (updated_at >= −950, by id) in front of the offset
    await c.runUntil(10 * 60_000); // every retry and the debounced push after the payment
    expect(backup.rows.get(1)?.spendable).toBe(true); // lost for good
    expect(inStep()).toBe(false);
  });

  test('(b) the new rule: the payment waits for the cycle in flight, then the next cycle sends every changed row', async () => {
    const { c, sync, pay, backup, inStep } = rig();
    const pushed = sync.syncNow();
    await c.runUntil(1_500);
    let waited = -1;
    void pay(1).then((w) => (waited = w));
    await c.runUntil(10 * 60_000);
    expect((await pushed).ok).toBe(true);
    // The cycle in flight: rows 5-12 in 4 pages + the empty last page, 1.05 s each, ends at 5.25 s; asked at 1.5 s.
    expect(waited).toBeGreaterThan(0);
    expect(waited).toBeLessThanOrEqual(5_250 - 1_500);
    expect(backup.rows.get(1)?.spendable).toBe(false);
    expect(inStep()).toBe(true);
  });

  test('a push asked for while an own payment runs starts after it; the payment never queues behind it', async () => {
    const { c, sync, pay, inStep } = rig();
    let waited = -1;
    void pay(3, 2_000).then((w) => (waited = w));
    await c.runUntil(10);
    const pushed = sync.syncNow();
    await c.runUntil(10 * 60_000);
    expect(waited).toBe(0);
    expect((await pushed).ok).toBe(true);
    expect(inStep()).toBe(true);
  });

  test('(c) a page the backup committed but answered after the deadline: neither lost nor sent twice', async () => {
    // Call 2 (rows 9-10) commits, then answers 90 s later; the client gives up at PUSH_CALL_MS.
    const { c, sync, backup, inStep, log } = rig({ pageMs: 500, answerLate: new Map([[2, 90_000]]) });
    const first = sync.syncNow();
    await c.runUntil(PUSH_CALL_MS + 5_000);
    expect((await first).ok).toBe(false); // never success
    expect(sync.state().pendingPush).toBe(true);
    expect(log.some((l) => l.includes('did not answer in time'))).toBe(true);
    await c.runUntil(PUSH_CALL_MS + 5_000 + BACKOFF_MS[0] + 60_000);
    expect(inStep()).toBe(true);
    for (const [, n] of backup.received) expect(n).toBe(1); // no row version arrived twice
    expect(backup.maxConcurrent()).toBe(1); // never a second processSyncChunk alongside the late one
  });

  test('a backup still answering an earlier request is not sent a second page (in flight), and that is a failure', async () => {
    const { c, sync, backup, log } = rig({ pageMs: 500, answerLate: new Map([[2, 10 * 60_000]]) });
    void sync.syncNow();
    await c.runUntil(PUSH_CALL_MS + 5_000 + BACKOFF_MS[0] + SETTLE_WAIT_MS + 5_000);
    expect(backup.maxConcurrent()).toBe(1);
    expect(log.some((l) => l.includes('still answering an earlier request'))).toBe(true);
    expect(sync.state().pendingPush).toBe(true);
  });

  test('a deadline failure backs off at most 4 minutes, never the 30-minute end of the ladder', async () => {
    const { c, sync, log } = rig({ pageMs: 500, answerLate: new Map([[0, 1e12]]) });
    void sync.syncNow();
    await c.runUntil(3 * 60 * 60_000);
    const waits = log
      .filter((l) => l.includes('failed (retry in'))
      .map((l) => Number(/retry in (\d+) min/.exec(l)?.[1]));
    expect(waits.length).toBeGreaterThan(3);
    expect(Math.max(...waits)).toBeLessThanOrEqual(4);
  });
});

describe('makeBackupPush: the real push wiring (initWallet)', () => {
  test('getAuth(true) once, each backup in turn; a waiting payment goes first only BETWEEN backups', async () => {
    const order: string[] = [];
    let paying = false;
    let arrives = true;
    const storage = {
      getAuth: async (mustBeActive?: boolean) => (order.push(`auth:${mustBeActive}`), { identityKey: 'k' }),
      syncToWriter: async (_a: unknown, w: { name: string }) => {
        order.push(`push:${w.name}`);
        if (arrives) paying = true; // a payment arrives during the first backup's cycle; that cycle is NOT interrupted
      },
    };
    const push = makeBackupPush({
      storage: storage as never,
      backups: () => [{ storage: { name: 'A' } }, { storage: { name: 'B' } }],
      waiting: () => paying,
      inFlightFor: () => createInFlight(),
    });
    expect(await push()).toBe('yielded');
    expect(order).toEqual(['auth:true', 'push:A']);
    paying = false;
    arrives = false;
    order.length = 0;
    expect(await push()).toBeUndefined();
    expect(order).toEqual(['auth:true', 'push:A', 'push:B']);
  });
  test('the view keeps a deadline but never answers a page as the last one', async () => {
    const w = { processSyncChunk: async () => ({ done: false }) };
    const v = pushView(w, { inFlight: createInFlight() });
    expect(await v.processSyncChunk()).toEqual({ done: false });
  });
});

describe('the pull yields at a page (full-pass page guard, slice mode)', () => {
  test("after a merged page, a waiting own payment ends the slice ('yield'); without one it goes on", async () => {
    const gate = createOwnPaymentGate();
    const sik = 'device-sik-own-payments';
    await withFullPassMode(sik, 'slice', async () => {
      expect(beforePage(sik, { fromStart: false, ours: false }, 0)).toBe('go');
      expect(afterPage(sik, 1, gate)).toBe('go');
      const end = gate.begin();
      const before = paymentYields();
      expect(afterPage(sik, 2, gate)).toBe('yield');
      expect(paymentYields()).toBe(before + 1);
      end();
      expect(afterPage(sik, 3, gate)).toBe('go');
    });
  });
  test('outside slice mode (a restore, a heal, the merge at open) a payment changes nothing here', async () => {
    const gate = createOwnPaymentGate();
    const end = gate.begin();
    expect(afterPage('no-mode-sik', 1, gate)).toBe('go');
    await withFullPassMode('heal-sik', 'defer', async () => {
      expect(afterPage('heal-sik', 1, gate)).toBe('go');
    });
    end();
  });
});

describe('the own-payment gate', () => {
  test('waiting while any payment runs; idle resolves when the last ends; end is idempotent', async () => {
    const gate = createOwnPaymentGate();
    await gate.idle();
    const a = gate.begin();
    const b = gate.begin();
    let idle = false;
    void gate.idle().then(() => (idle = true));
    a();
    a();
    await Promise.resolve();
    expect(gate.waiting()).toBe(true);
    expect(idle).toBe(false);
    b();
    await new Promise((r) => setImmediate(r));
    expect(gate.waiting()).toBe(false);
    expect(idle).toBe(true);
  });
});
