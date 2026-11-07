/**
 * Own payments go first (owner's seal, 7 Nov 2026, doc dbb9beec): the seal's one createAction took ~25 s, ten seconds
 * after the app opened, while the open-time device sync (pull, then a push with no deadline) held the toolbox's single
 * first-come-first-served storage queue.
 *
 * The repro below runs the REAL pieces (createDeviceSync, the push view, the own-payment gate, the full-pass page guard)
 * over a fake storage manager whose locks are the toolbox's own algorithm (WalletStorageManager.getActiveLock /
 * releaseActiveLock: one FIFO per lock kind, a writer takes reader + writer, a sync takes reader + writer + sync) and
 * whose sync loop is syncToWriter's: load the checkpoint from the writer's durable state, then page by page
 * getSyncChunk → processSyncChunk until a page says done. The backup's processSyncChunk commits each page and its
 * checkpoint together, as the toolbox's does (one transaction). Time is virtual.
 */
import { describe, expect, test } from 'bun:test';
import { createOwnPaymentGate } from './ownPayments';
import { PUSH_CALL_MS, pushView } from './pushView';
import { createDeviceSync } from './deviceSync';
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
    /** Run timers in time order until `until` (virtual ms) or nothing is left. */
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

// ── the toolbox's lock queue and syncToWriter loop, over fakes ───────────────
const fakeManager = (c: ReturnType<typeof vclock>, local: string[], pageSize: number, readMs: number) => {
  const readerLocks: (() => void)[] = [];
  const writerLocks: (() => void)[] = [];
  const syncLocks: (() => void)[] = [];
  // WalletStorageManager.getActiveLock / releaseActiveLock, verbatim in behaviour.
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
  type Writer = {
    makeAvailable(): Promise<unknown>;
    getSyncCheckpoint(): Promise<{ since: number }>;
    processSyncChunk(args: { since: number }, chunk: { rows: string[]; next: number }): Promise<{ done: boolean }>;
  };
  // syncToWriter: checkpoint from the writer, then pages until done; the local reader reads `pageSize` rows a page.
  const syncToWriter = (writer: Writer) =>
    runAsSync(async () => {
      await writer.makeAvailable();
      let args = { since: (await writer.getSyncCheckpoint()).since };
      for (;;) {
        await c.sleep(readMs); // reader.getSyncChunk on this device
        const rows = local.slice(args.since, args.since + pageSize);
        const r = await writer.processSyncChunk(args, { rows, next: args.since + rows.length });
        if (r.done) break;
        args = { since: (await writer.getSyncCheckpoint()).since };
      }
    });
  return { runAsWriter, syncToWriter, queued: () => readerLocks.length };
};

/** The backup: each page and its checkpoint commit together; `slowPages` take `slowMs`, and may never answer. */
const fakeBackup = (c: ReturnType<typeof vclock>, o: { pageMs: number; hangOnce?: Set<number> }) => {
  const received: string[] = [];
  let since = 0;
  let calls = 0;
  return {
    received,
    get since() {
      return since;
    },
    writer: {
      async makeAvailable() {
        return {};
      },
      async getSyncCheckpoint() {
        return { since };
      },
      async processSyncChunk(args: { since: number }, chunk: { rows: string[]; next: number }) {
        const n = calls++;
        if (o.hangOnce?.has(n)) {
          o.hangOnce.delete(n);
          await new Promise(() => undefined); // never answers (the deadline must end it)
        }
        await c.sleep(o.pageMs);
        if (args.since !== since) throw new Error('checkpoint changed'); // requireMatchingCheckpoint
        received.push(...chunk.rows);
        since = chunk.next;
        return { done: chunk.rows.length === 0 };
      },
    },
  };
};

const ROWS = Array.from({ length: 12 }, (_, i) => `row${i}`);

/** The device sync wired as initWallet wires it: the push through pushView, yielding to own payments. */
const rig = (o: { pageMs?: number; hangOnce?: Set<number> } = {}) => {
  const c = vclock();
  const gate = createOwnPaymentGate();
  const mgr = fakeManager(c, ROWS, 2, 50);
  const backup = fakeBackup(c, { pageMs: o.pageMs ?? 1_000, hangOnce: o.hangOnce });
  const log: string[] = [];
  const sync = createDeviceSync({
    applies: () => true,
    ensureBackup: async () => true,
    pull: async () => undefined,
    push: async () => {
      let yielded = false;
      await mgr.syncToWriter(
        pushView(backup.writer, {
          waiting: gate.waiting,
          onYield: () => (yielded = true),
          setTimer: c.setTimer,
          clearTimer: c.clearTimer,
        }),
      );
      return yielded ? 'yielded' : undefined;
    },
    yieldTo: gate,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
    now: c.now,
    log: (...a) => void log.push(a.map(String).join(' ')),
  });
  /** An own payment: the gate first (as the background's createAction does), then the storage queue. */
  const pay = async (holdMs: number) => {
    const end = gate.begin();
    const askedAt = c.now();
    try {
      return await mgr.runAsWriter(async () => {
        const waited = c.now() - askedAt;
        await c.sleep(holdMs);
        return waited;
      });
    } finally {
      end();
    }
  };
  return { c, gate, mgr, backup, sync, pay, log };
};

describe('own payments go first: the repro (seal 7 Nov 2026)', () => {
  test('a payment during a slow push gets the queue at the next page boundary, then the push finishes, each row once', async () => {
    const { c, backup, sync, pay } = rig({ pageMs: 1_000 });
    const pushed = sync.syncNow();
    await c.runUntil(1_500); // the push is in its second page (pages end at 1050 ms, 2100 ms, …)
    expect(backup.received.length).toBe(2);
    let waited = -1;
    void pay(300).then((w) => (waited = w));
    await c.runUntil(60_000);
    // Before: queued behind all 7 pages (~7 s, unbounded with a stalled backup). Now: the page in flight only.
    expect(waited).toBeGreaterThanOrEqual(0);
    expect(waited).toBeLessThan(1_100);
    const r = await pushed;
    expect(r.ok).toBe(true);
    expect(backup.received).toEqual(ROWS); // every row, exactly once, in order
    expect(sync.state().pendingPush).toBe(false);
  });

  test('a page the backup never answers times out (no success), is retried on the back-off, and nothing is lost', async () => {
    const { c, backup, sync, log } = rig({ pageMs: 500, hangOnce: new Set([2]) });
    const first = await (async () => {
      const p = sync.syncNow();
      await c.runUntil(PUSH_CALL_MS + 5_000);
      return p;
    })();
    expect(first.ok).toBe(false);
    expect(sync.state().pendingPush).toBe(true); // never treated as done
    expect(log.some((l) => l.includes('[deviceSync] full failed'))).toBe(true);
    expect(backup.received).toEqual(ROWS.slice(0, 4)); // the two committed pages stay
    await c.runUntil(PUSH_CALL_MS + 5_000 + 61_000); // the 1-minute back-off retry
    expect(backup.received).toEqual(ROWS);
    expect(sync.state().pendingPush).toBe(false);
  });

  test('two own payments in a row both go before the sync, and the sync still moves on between them', async () => {
    const { c, backup, sync, pay } = rig({ pageMs: 1_000 });
    const pushed = sync.syncNow();
    await c.runUntil(1_500);
    const waits: number[] = [];
    void pay(400).then((w) => waits.push(w)); // gets the queue at 2100 ms, done at 2500 ms
    await c.runUntil(3_000); // the sync resumed at 2500 ms: its next page is in flight
    expect(waits.length).toBe(1);
    expect(backup.received.length).toBe(4);
    void pay(400).then((w) => waits.push(w)); // the next one, in a row
    await c.runUntil(3_600);
    // Not starved: the page in flight committed before the second payment took the queue (3550 ms).
    expect(backup.received.length).toBe(6);
    await c.runUntil(60_000);
    expect(waits.length).toBe(2);
    for (const w of waits) expect(w).toBeLessThan(1_100);
    expect((await pushed).ok).toBe(true);
    expect(backup.received).toEqual(ROWS);
  });

  test('a sync asked for while an own payment runs starts only after it, so the payment never queues behind it', async () => {
    const { c, backup, sync, pay } = rig({ pageMs: 1_000 });
    let waited = -1;
    void pay(2_000).then((w) => (waited = w));
    await c.runUntil(10);
    const pushed = sync.syncNow();
    await c.runUntil(1_000);
    expect(backup.received.length).toBe(0);
    await c.runUntil(60_000);
    expect(waited).toBe(0);
    expect((await pushed).ok).toBe(true);
    expect(backup.received).toEqual(ROWS);
  });
});

describe('the pull yields too (full-pass page guard, slice mode)', () => {
  test("after a merged page, a waiting own payment ends the slice ('yield'); without one, a short slice goes on", async () => {
    const gate = createOwnPaymentGate();
    const sik = 'device-sik-own-payments';
    await withFullPassMode(sik, 'slice', async () => {
      expect(beforePage(sik, { fromStart: false, ours: false }, 0)).toBe('go');
      expect(afterPage(sik, 1, gate)).toBe('go');
      const end = gate.begin();
      const before = paymentYields();
      expect(afterPage(sik, 2, gate)).toBe('yield');
      expect(paymentYields()).toBe(before + 1); // the device-sync pull reads this to carry on in the same run
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
    await gate.idle(); // idle at once with none
    const a = gate.begin();
    const b = gate.begin();
    let idle = false;
    void gate.idle().then(() => (idle = true));
    a();
    a(); // a second end of the same payment changes nothing
    await Promise.resolve();
    expect(gate.waiting()).toBe(true);
    expect(idle).toBe(false);
    b();
    await new Promise((r) => setImmediate(r));
    expect(gate.waiting()).toBe(false);
    expect(idle).toBe(true);
  });
});
