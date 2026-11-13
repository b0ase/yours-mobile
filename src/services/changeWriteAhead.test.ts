import { describe, expect, test } from 'bun:test';
import {
  asSending,
  COOL_OFF_MS,
  createChangeWriteAhead,
  onBroadcast,
  processActionSends,
  URGENT_RETRY_MS,
  watchStorage,
  type WriteAheadDeps,
} from './changeWriteAhead';
import { createInFlight, pushView, type InFlight } from './pushView';
import { createSyncHealth } from './syncHealth';
import { backupLine, truthLines } from './balanceTruth';

const TX = 'a'.repeat(64);
const TX2 = 'b'.repeat(64);
const OLD = 'c'.repeat(64);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A storage manager stand-in: writerLocks as the toolbox keeps them, syncToWriter driving the backup view it is given. */
function harness(o: Partial<WriteAheadDeps> & { push?: (view: Record<string, (...a: unknown[]) => Promise<unknown>>) => Promise<void> } = {}) {
  const events: string[] = [];
  const active = {
    name: 'device store',
    findProvenTxReqs: async ({ partial }: { partial: { txid: string } }) =>
      partial.txid === TX ? [{ txid: TX, rawTx: [1, 2, 3], status: 'unprocessed' }] : [],
  };
  const syncCalls: { activeSync: unknown }[] = [];
  const storage = {
    writerLocks: [] as unknown[],
    spLocks: [] as unknown[],
    getActive: () => active,
    getAuth: async () => ({ identityKey: 'id', userId: 1, isActive: true }),
    async syncToWriter(_auth: unknown, writer: object, activeSync?: unknown) {
      syncCalls.push({ activeSync });
      events.push('push');
      const view = writer as Record<string, (...a: unknown[]) => Promise<unknown>>;
      if (o.push) return o.push(view);
      await view.makeAvailable();
      await view.processSyncChunk({}, { transactions: [{ txid: TX, status: 'unprocessed' }] });
    },
  };
  const backup = {
    chunks: [] as unknown[],
    makeAvailable: async () => ({}),
    processSyncChunk: async (_a: unknown, chunk: unknown) => {
      backup.chunks.push(chunk);
      return { done: true };
    },
  };
  const inFlights = new Map<object, InFlight>();
  const changes: number[] = [];
  let saved: unknown = 'never';
  const timers: { fn: () => void; ms: number }[] = [];
  let pushNowCalls = 0;
  const wa = createChangeWriteAhead({
    applies: () => true,
    backups: () => [{ storage: backup }],
    storage,
    inFlightFor: (b) => {
      let f = inFlights.get(b);
      if (!f) inFlights.set(b, (f = createInFlight()));
      return f;
    },
    pushNow: async () => {
      pushNowCalls++;
      return { ok: true, pulled: false, pushed: true };
    },
    onChange: (n) => changes.push(n),
    kv: { load: async () => null, save: async (r) => void (saved = r) },
    retryTimer: { set: (fn, ms) => (timers.push({ fn, ms }), timers.length), clear: () => undefined },
    log: () => undefined,
    ...o,
  });
  // The broadcaster: records the post after whatever the write-ahead did.
  const services = {
    posted: [] as string[][],
    postBeef: async (_beef: unknown, txids: string[]) => {
      events.push(`post ${txids.map((t) => t.slice(0, 2)).join(',')}`);
      services.posted.push(txids);
      return [{ status: 'success' }];
    },
  };
  onBroadcast(services, wa);
  // processAction as the toolbox's manager runs it: the writer lock held while it commits and posts.
  const manager = {
    ...storage,
    processAction: async (args: {
      isNewTx: boolean;
      txid: string;
      sendWith: string[];
      isNoSend?: boolean;
      isDelayed?: boolean;
    }) => {
      storage.writerLocks.push('held');
      try {
        if (args.isDelayed) return 'queued';
        const send = processActionSends(args);
        if (send.length) await services.postBeef({}, send);
        return 'done';
      } finally {
        storage.writerLocks.shift();
      }
    },
    // internalizeAction of a payment the network hasn't seen: posts it under the writer lock (outputs written after).
    internalizeAction: async (args: { tx: number[]; txid: string }) => {
      storage.writerLocks.push('held');
      try {
        await services.postBeef({}, [args.txid]);
      } finally {
        storage.writerLocks.shift();
      }
    },
  };
  watchStorage(manager, wa);
  /** createAction / signAction / sendWith as they reach storage processAction. */
  const pa = (a: { txid: string; sendWith?: string[]; isNoSend?: boolean; isDelayed?: boolean }) =>
    manager.processAction({ isNewTx: true, sendWith: [], ...a });
  return {
    pa,
    wa,
    events,
    storage,
    manager,
    services,
    backup,
    syncCalls,
    changes,
    saved: () => saved,
    timers,
    pushNowCalls: () => pushNowCalls,
    inFlights,
    active,
  };
}

describe('which txids a storage call sends (the toolbox rule)', () => {
  test('processAction: a new tx unless noSend; sendWith always; noSend with sendWith sends both', () => {
    expect(processActionSends({ isNewTx: true, txid: TX, sendWith: [] })).toEqual([TX]);
    expect(processActionSends({ isNewTx: true, txid: TX, isNoSend: true, sendWith: [] })).toEqual([]);
    expect(processActionSends({ isNewTx: false, sendWith: [TX2] })).toEqual([TX2]);
    expect(processActionSends({ isNewTx: true, txid: TX, isNoSend: true, isSendWith: true, sendWith: [TX2] })).toEqual([
      TX2,
      TX,
    ]);
    expect(processActionSends(undefined)).toEqual([]);
  });
});

describe('the push before a broadcast', () => {
  test("a payment's rows are pushed BEFORE it is posted, inside the caller's writer lock (no lock taken)", async () => {
    const h = harness();
    expect(await h.pa({ txid: TX })).toBe('done');
    expect(h.events).toEqual(['push', `post ${TX.slice(0, 2)}`]);
    expect(h.syncCalls[0].activeSync).toBe(h.active); // the caller's lock: runAsSync takes none
    expect(h.wa.count()).toBe(0);
  });

  test('the backup is told "sending" (request "nosend": no copy ever sends it), with the raw bytes, never "unprocessed"', async () => {
    const h = harness({
      push: async (view) => {
        await view.processSyncChunk(
          {},
          { transactions: [{ txid: TX, status: 'unprocessed' }], provenTxReqs: [{ txid: TX, status: 'unprocessed' }] },
        );
      },
    });
    await h.pa({ txid: TX });
    const chunk = h.backup.chunks[0] as { transactions: { status: string; rawTx?: number[] }[]; provenTxReqs: unknown[] };
    expect(chunk.transactions[0]).toMatchObject({ status: 'sending', rawTx: [1, 2, 3] });
    expect(chunk.provenTxReqs[0]).toMatchObject({ status: 'nosend' });
  });

  test('a post of a txid no running call armed (a heal rebroadcasting an old tx) is untouched', async () => {
    const h = harness();
    await h.services.postBeef({}, [OLD]);
    expect(h.events).toEqual([`post ${OLD.slice(0, 2)}`]);
    // …and once processAction has returned, its txid is no longer armed either.
    await h.pa({ txid: TX });
    h.events.length = 0;
    await h.services.postBeef({}, [TX]);
    expect(h.events).toEqual([`post ${TX.slice(0, 2)}`]);
  });

  test('a noSend createAction posts nothing and pushes nothing; its later sendWith pushes first', async () => {
    const h = harness();
    await h.pa({ txid: TX, isNoSend: true });
    expect(h.events).toEqual([]);
    await h.pa({ txid: TX2, isNoSend: true, sendWith: [TX] });
    expect(h.events).toEqual(['push', `post ${TX.slice(0, 2)},${TX2.slice(0, 2)}`]);
  });

  test('a delayed send stays armed until the Monitor posts it', async () => {
    const h = harness();
    expect(await h.pa({ txid: TX, isDelayed: true })).toBe('queued');
    expect(h.events).toEqual([]);
    h.storage.writerLocks.push('monitor'); // runAsStorageProvider
    h.storage.spLocks.push('monitor');
    await h.services.postBeef({}, [TX]);
    h.storage.writerLocks.shift();
    h.storage.spLocks.shift();
    expect(h.events).toEqual(['push', `post ${TX.slice(0, 2)}`]);
    expect(h.syncCalls[0].activeSync).toBe(h.active);
    h.events.length = 0;
    await h.services.postBeef({}, [TX]); // a later rebroadcast: no longer armed
    expect(h.events).toEqual([`post ${TX.slice(0, 2)}`]);
  });

  test('internalizeAction is not armed: its outputs are written after the broadcast, so a push before it has none', async () => {
    const h = harness();
    // Atomic BEEF naming TX (BRC-95: 0x01010101, then the txid reversed; TX reads the same both ways).
    await h.manager.internalizeAction({ tx: [1, 1, 1, 1, ...new Array(32).fill(0xaa)], txid: TX });
    expect(h.events).toEqual([`post ${TX.slice(0, 2)}`]);
    expect(h.wa.count()).toBe(0); // a receive is never reported as "change not backed up yet"
  });

  test('no writer lock held (an unknown caller): the cycle takes the locks itself', async () => {
    const h = harness();
    h.wa.arm([TX]);
    await h.services.postBeef({}, [TX]);
    expect(h.syncCalls[0].activeSync).toBeUndefined();
  });

  test('a writer lock held by a call the poster cannot be shown to be: no push (never inside another call), flagged', async () => {
    const h = harness();
    h.wa.arm([TX], { delayed: true }); // a delayed send…
    h.storage.writerLocks.push('someone else'); // …posted while a writer that is not the Monitor holds the lock
    await h.services.postBeef({}, [TX]);
    h.storage.writerLocks.shift();
    expect(h.syncCalls).toEqual([]);
    expect(h.services.posted).toEqual([[TX]]);
    expect(h.wa.count()).toBe(1);
    // A busy lock says nothing about the backup: the next payment still pushes first.
    await h.pa({ txid: TX2 });
    expect(h.syncCalls.length).toBe(1);
    expect(h.wa.count()).toBe(0);
  });

  test('no backup configured, or the remote store active: nothing pushed, nothing flagged', async () => {
    const h = harness({ applies: () => false });
    await h.pa({ txid: TX });
    expect(h.events).toEqual([`post ${TX.slice(0, 2)}`]);
    expect(h.wa.count()).toBe(0);
  });
});

describe('policy: the backup never stops a payment', () => {
  test('backup down: the payment is still posted, flagged, and retried urgently until a push lands', async () => {
    let up = false;
    let pushes = 0;
    const h = harness({
      push: async (view) => {
        if (!up) throw new Error('network: the backup is down');
        await view.makeAvailable();
      },
      pushNow: async () => {
        pushes++;
        return up ? { ok: true, pulled: false, pushed: true } : { ok: false, error: 'down' };
      },
    });
    await h.pa({ txid: TX });
    expect(h.services.posted).toEqual([[TX]]); // went out
    expect(h.wa.unbacked().map((u) => u.txid)).toEqual([TX]);
    expect(h.changes.at(-1)).toBe(1);
    expect(h.saved()).toMatchObject({ txids: [TX] });
    expect(h.timers.map((t) => t.ms)).toEqual([URGENT_RETRY_MS[0]]);
    // The urgent retry while still down: still flagged, next wait longer.
    h.timers.shift()!.fn();
    await sleep(0);
    expect(pushes).toBe(1);
    expect(h.wa.count()).toBe(1);
    expect(h.timers.map((t) => t.ms)).toEqual([URGENT_RETRY_MS[1]]);
    up = true;
    h.timers.shift()!.fn();
    await sleep(0);
    expect(h.wa.count()).toBe(0);
    expect(h.changes.at(-1)).toBe(0);
    expect(h.saved()).toBeNull();
    expect(h.timers).toEqual([]); // nothing left to retry
  });

  test('a backup that never answers: the payment waits at most the budget, and the cycle has ended before the post', async () => {
    let cycleEnded = false;
    const never = new Promise<never>(() => undefined);
    const h = harness({
      budgetMs: 40,
      push: async (view) => {
        try {
          await view.makeAvailable();
        } finally {
          cycleEnded = true;
        }
      },
    });
    (h.backup as Record<string, unknown>).makeAvailable = () => never;
    const t0 = Date.now();
    await h.pa({ txid: TX });
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(cycleEnded).toBe(true);
    expect(h.events).toEqual(['push', `post ${TX.slice(0, 2)}`]);
    expect(h.wa.count()).toBe(1);
    // The timed-out request is still "in flight" for that backup: no second request until it settles.
    expect(await h.inFlights.get(h.backup)!.settled(0)).toBe(false);
  });

  test('a backup still answering an earlier timed-out request: no new request and no wait (the lock is held), flagged at once', async () => {
    const h = harness({ budgetMs: 5_000 });
    const f = createInFlight();
    f.add(new Promise(() => undefined));
    h.inFlights.set(h.backup, f);
    const t0 = Date.now();
    await h.pa({ txid: TX });
    expect(Date.now() - t0).toBeLessThan(500); // was: the whole budget, holding the writer lock
    expect(h.syncCalls).toEqual([]);
    expect(h.services.posted).toEqual([[TX]]);
    expect(h.wa.count()).toBe(1);
  });

  test('after a failed push, payments skip the write-ahead for the cool-off (flagged at once) until a push goes through', async () => {
    let t = 1_000_000;
    let up = false;
    const h = harness({
      now: () => t,
      push: async (view) => {
        if (!up) throw new Error('network: the backup is down');
        await view.makeAvailable();
      },
    });
    await h.pa({ txid: TX }); // fails: cool-off starts
    expect(h.syncCalls.length).toBe(1);
    up = true;
    t += 1_000;
    await h.pa({ txid: TX2 }); // inside the cool-off: not pushed, flagged
    expect(h.syncCalls.length).toBe(1);
    expect(h.services.posted).toEqual([[TX], [TX2]]);
    expect(h.wa.count()).toBe(2);
    // The cool-off ends with its time…
    t += COOL_OFF_MS;
    await h.pa({ txid: OLD });
    expect(h.syncCalls.length).toBe(2);
    expect(h.wa.count()).toBe(0); // that push carried the earlier two
    // …or as soon as a push goes through (the urgent retry, or the device sync's).
    up = false;
    await h.pa({ txid: TX });
    up = true;
    expect(await h.wa.retryNow()).toBe(true);
    await h.pa({ txid: TX2 });
    expect(h.syncCalls.length).toBe(4);
  });

  test('backup configured but not connected: flagged (and the urgent retry reconnects through pushNow)', async () => {
    const h = harness({ backups: () => [] });
    await h.pa({ txid: TX });
    expect(h.services.posted).toEqual([[TX]]);
    expect(h.wa.count()).toBe(1);
    expect(await h.wa.retryNow()).toBe(true);
    expect(h.pushNowCalls()).toBe(1);
  });

  test('an ordinary device-sync push clears only what was marked before it started', async () => {
    let fail = true;
    const h = harness({
      push: async () => {
        if (fail) throw new Error('down');
      },
    });
    await h.pa({ txid: TX });
    const cap = h.wa.checkpoint(); // a device-sync push starts here
    await h.pa({ txid: TX2 }); // marked after it started
    expect(h.wa.count()).toBe(2);
    h.wa.pushed(cap);
    expect(h.wa.unbacked().map((u) => u.txid)).toEqual([TX2]);
    // The next payment's own push before broadcast carries the earlier one too.
    fail = false;
    await h.pa({ txid: OLD });
    expect(h.wa.count()).toBe(0);
  });

  test('marks survive a restart (persisted) and the first push after it clears them', async () => {
    const h = harness({ kv: { load: async () => ({ txids: [TX], since: 5 }), save: async () => undefined } });
    await h.wa.hydrate();
    expect(h.wa.unbacked()).toEqual([{ txid: TX, at: 5 }]);
    h.wa.pushed(h.wa.checkpoint());
    expect(h.wa.count()).toBe(0);
  });

  test('the remote store became active: the marks are dropped, nothing retried', async () => {
    let applies = true;
    const h = harness({ applies: () => applies, push: async () => Promise.reject(new Error('down')) });
    await h.pa({ txid: TX });
    applies = false;
    expect(await h.wa.retryNow()).toBe(true);
    expect(h.wa.count()).toBe(0);
    expect(h.pushNowCalls()).toBe(0);
  });
});

describe('what the backup is told (asSending)', () => {
  test('only the payment going out changes; this device’s rows are never touched', async () => {
    const tx = { txid: TX, status: 'unprocessed' };
    const other = { txid: TX2, status: 'unprocessed' };
    const req = { txid: TX, status: 'unprocessed', rawTx: [9] };
    const chunk = { transactions: [tx, other], provenTxReqs: [req], outputs: [{ vout: 0 }] };
    const out = await asSending(chunk, new Set([TX]), async () => [7, 7]);
    expect(out.transactions).toEqual([{ txid: TX, status: 'sending', rawTx: [7, 7] }, other]);
    expect(out.provenTxReqs).toEqual([{ txid: TX, status: 'nosend', rawTx: [9] }]);
    expect(out.outputs).toBe(chunk.outputs);
    expect(tx).toEqual({ txid: TX, status: 'unprocessed' }); // the device's copy untouched
    expect(req.status).toBe('unprocessed');
  });

  test('a transaction in another state keeps it (a sendWith of a nosend, a delayed "sending"); bytes already there stay', async () => {
    const chunk = {
      transactions: [
        { txid: TX, status: 'nosend', rawTx: [1] },
        { txid: TX2, status: 'sending' },
      ],
      provenTxReqs: [{ txid: TX, status: 'nosend' }],
    };
    const out = await asSending(chunk, new Set([TX, TX2]), async () => undefined);
    expect(out.transactions).toEqual([
      { txid: TX, status: 'nosend', rawTx: [1] },
      { txid: TX2, status: 'sending' },
    ]);
    expect(out.provenTxReqs).toEqual([{ txid: TX, status: 'nosend' }]);
  });

  test('a delayed send (request already "unsent", queued by the toolbox) or one tried before ("sending") goes as "nosend" too', async () => {
    const chunk = {
      transactions: [{ txid: TX, status: 'sending', rawTx: [1] }],
      provenTxReqs: [
        { txid: TX, status: 'unsent' },
        { txid: TX2, status: 'sending' },
        { txid: OLD, status: 'unsent' }, // not being posted: untouched
      ],
    };
    const out = await asSending(chunk, new Set([TX, TX2]), async () => undefined);
    expect(out.provenTxReqs).toEqual([
      { txid: TX, status: 'nosend' },
      { txid: TX2, status: 'nosend' },
      { txid: OLD, status: 'unsent' },
    ]);
  });

  test('a page with none of them goes as it is', async () => {
    const chunk = { transactions: [{ txid: OLD, status: 'unprocessed' }] };
    expect(await asSending(chunk, new Set([TX]), async () => [1])).toBe(chunk);
  });
});

describe('pushView: the write-ahead deadline, only until the first data page is sent', () => {
  test('each request gets what is left; one asked for after the deadline fails without being sent', async () => {
    let t = 1_000;
    let sent = 0;
    const backup = {
      makeAvailable: async () => void sent++,
      getSyncCheckpoint: async () => void sent++,
    };
    const v = pushView(backup, { inFlight: createInFlight(), deadlineAt: 1_050, now: () => t });
    await v.makeAvailable();
    t = 1_050;
    await expect(v.getSyncCheckpoint()).rejects.toThrow('did not answer in time');
    expect(sent).toBe(1);
  });

  test('the first data page is never started with too little left; one started gets the ordinary limit', async () => {
    let t = 1_000;
    let sent = 0;
    const backup = {
      processSyncChunk: async () => {
        sent++;
        t += 5_000; // answers after the deadline
        return { done: false };
      },
    };
    const late = pushView(backup, { inFlight: createInFlight(), deadlineAt: 1_000 + 1_999, now: () => t });
    await expect(late.processSyncChunk({}, {})).rejects.toThrow('did not answer in time');
    expect(sent).toBe(0); // never sent: nothing for the backup to commit late
    const v = pushView(backup, { inFlight: createInFlight(), deadlineAt: 1_000 + 2_000, now: () => t });
    await v.processSyncChunk({}, {}); // started in time: not cut by the deadline (a cut page may commit late)
    expect(sent).toBe(1);
  });

  test('a first page that outlasts the deadline is never given up on at it (the backup could commit it later)', async () => {
    const f = createInFlight();
    let answer: (v: unknown) => void = () => undefined;
    const backup = { processSyncChunk: () => new Promise((r) => (answer = r)) };
    const v = pushView(backup, { inFlight: f, deadlineAt: Date.now() + 2_050 });
    let settled = false;
    const p = v.processSyncChunk({}, {}).then(() => (settled = true));
    await sleep(2_200); // past the deadline
    expect(settled).toBe(false);
    answer({ done: true });
    await p;
    expect(await f.settled(0)).toBe(true); // nothing left "in flight"
  });

  test('once a page is sent the cycle is never cut by it (a cycle cut mid-way is the never-paused hazard)', async () => {
    let t = 1_000;
    const pages: number[] = [];
    const backup = {
      processSyncChunk: async (_a: unknown, n: number) => {
        pages.push(n);
        t += 5_000; // a slow backup: each page takes 5 s
        return { done: false };
      },
    };
    const v = pushView(backup, { inFlight: createInFlight(), deadlineAt: 1_000 + 8_000, now: () => t });
    await v.processSyncChunk({}, 1); // sent at 0 s, committed at 5 s
    await v.processSyncChunk({}, 2); // asked at 5 s, answered at 10 s: past the deadline, finished anyway
    await v.processSyncChunk({}, 3); // asked after the deadline: sent all the same
    expect(pages).toEqual([1, 2, 3]);
  });

  test('without deadlineAt nothing changes (the device sync push)', async () => {
    const backup = { makeAvailable: async () => 'ok' };
    const v = pushView(backup, { inFlight: createInFlight() });
    expect(await v.makeAvailable()).toBe('ok');
  });
});

describe('where it shows', () => {
  test('syncHealth.changeNotBackedUp follows the count', () => {
    const h = createSyncHealth();
    const seen: number[] = [];
    h.subscribe((x) => seen.push(x.changeNotBackedUp));
    expect(h.get().changeNotBackedUp).toBe(0);
    h.changeNotBackedUp(1);
    h.changeNotBackedUp(1); // unchanged: not published again
    h.changeNotBackedUp(0);
    expect(seen).toEqual([1, 0]);
  });

  test('the balance card line', () => {
    expect(backupLine({ changeUnbacked: 1 })).toEqual({
      kind: 'backup',
      text: "1 payment's change not backed up yet",
      warn: true,
    });
    expect(backupLine({ changeUnbacked: 3 })?.text).toBe("3 payments' change not backed up yet");
    expect(backupLine({ changeUnbacked: 0 })).toBeNull();
    expect(backupLine({})).toBeNull();
    const lines = truthLines(
      { held: [], arrivingSats: 0, syncApplies: false, changeUnbacked: 1 },
      (s) => `${s}`,
      Date.now(),
      { hideAmounts: true },
    );
    expect(lines.map((l) => l.kind)).toEqual(['backup']);
  });
});
