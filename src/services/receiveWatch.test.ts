import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Beef, LockingScript, P2PKH, PrivateKey, Transaction, Utils, type WalletProtocol } from '@bsv/sdk';
import { DEPOSIT_BASKET } from '@1sat/types';
import { createInternalizeLock } from './internalizeLock';
import { createInternalizeBackoff } from './internalizeBackoff';
import { makeCoinIntake, type CoinKey } from './prioritySyncRun';
import { _resetReceiveState, arrivingNow, arrivingSats } from './receiveGuard';
import type { OutpointState } from './heldOutpoints';
import { makeSpendCheck } from './spendCheck';
import {
  BLOCK_SCORE_MAX,
  FETCHES_PER_LOOK,
  FOREGROUND_LEASE_MS,
  MAX_BACKOFF_MS,
  PULL_THROTTLE_MS,
  RATE_LIMITED_MS,
  WATCH_INTERVAL_MS,
  createPullTrigger,
  createReceiveWatch,
  lookDelay,
  ownerSyncReader,
  watchFrom,
  type ReceiveWatchDeps,
  type TxClass,
  type WatchRow,
} from './receiveWatch';

const key = PrivateKey.fromRandom();
const RECEIVE = key.toPublicKey().toAddress();
const hash = (a: string) => Utils.toHex(Utils.fromBase58Check(a).data as number[]);
const keyByHash = new Map<string, CoinKey>([
  [hash(RECEIVE), { derivationPrefix: '1sat', derivationSuffix: '0', protocolID: [1, 'onesat'] as WalletProtocol }],
]);

/** A payment of `sats` to our receive address (plus a stranger's output), and its BEEF. */
const payment = (sats: number) => {
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: Utils.toHex(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))),
    sourceOutputIndex: 0,
    unlockingScript: LockingScript.fromHex('00'),
    sequence: 0xffffffff,
  });
  tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress()), satoshis: 777 });
  tx.addOutput({ lockingScript: new P2PKH().lock(RECEIVE), satoshis: sats });
  const beef = new Beef();
  beef.mergeTransaction(tx);
  return { txid: tx.id('hex'), beef: beef.toBinary() };
};

/** One device: its storage rows, processed store, lock and the indexer the watcher reads. */
const device = (o: { active?: boolean } = {}) => {
  const stored = new Map<string, OutpointState>();
  const knownTx = new Set<string>();
  const processed = new Set<string>();
  const beefs = new Map<string, number[]>();
  const rows: WatchRow[] = [];
  const internalized: { txid: string; outputs: number[] }[] = [];
  const asked: { addresses: string[]; from: number }[] = [];
  const pulls: number[] = [];
  const changes: number[] = [];
  const fetched: string[] = [];
  /** The spend index: outpoint → spender (mempool included). */
  const index = new Map<string, string>();
  /** Transactions the classifier calls names (never downloaded). */
  const names = new Set<string>();
  const clock = { t: 1_800_000_000_000 };
  const lock = createInternalizeLock();
  const wallet = {
    internalizeAction: async (a: {
      tx: number[];
      outputs: { outputIndex: number; insertionRemittance?: unknown }[];
    }) => {
      await new Promise((r) => setTimeout(r, 2)); // storage takes time
      const txid = Beef.fromBinary(a.tx).atomicTxid!;
      internalized.push({ txid, outputs: a.outputs.map((x) => x.outputIndex) });
      for (const x of a.outputs) stored.set(`${txid}.${x.outputIndex}`, 'accounted');
      knownTx.add(txid);
      expect(JSON.stringify(a.outputs)).toContain(DEPOSIT_BASKET);
      return { accepted: true };
    },
  };
  const store = { has: async (t: string) => processed.has(t), add: async (t: string) => void processed.add(t) };
  const spends = makeSpendCheck({ index: async (b) => b.map((op) => index.get(op.replace('_', '.')) ?? null) });
  const askPull = createPullTrigger({ pull: async () => void pulls.push(clock.t), now: () => clock.t });
  const known = async (txids: string[]) => new Set(txids.filter((t) => knownTx.has(t)));
  const intake = makeCoinIntake({
    wallet: wallet as never,
    keyByHash,
    processed: store,
    lock,
    spends,
    knownTxids: known,
    foreignSpend: (s) => void askPull(s),
    unknownSpend: 'skip',
  });
  const state = { active: o.active ?? true };
  const deps: ReceiveWatchDeps = {
    active: () => state.active,
    addresses: () => [RECEIVE, RECEIVE],
    from: async () => watchFrom(974_209, clock.t),
    stream: (addresses, from) => {
      asked.push({ addresses, from });
      return (async function* () {
        for (const r of rows) yield r;
      })();
    },
    states: async (ops) => new Map(ops.map((op) => [op, stored.get(op) ?? 'absent'])),
    knownTxids: known,
    processed: async (t) => processed.has(t),
    classify: async (txids) => new Map(txids.map((t) => [t, (names.has(t) ? 'not-coin' : 'coin') as TxClass])),
    spends,
    askPull,
    fetchBeef: async (t) => {
      fetched.push(t);
      const b = beefs.get(t);
      if (!b) throw new Error('no beef');
      return b;
    },
    intake: async () => intake,
    changed: (n) => void changes.push(n),
    now: () => clock.t,
  };
  const watch = createReceiveWatch(deps);
  return {
    watch,
    deps,
    stored,
    knownTx,
    processed,
    beefs,
    rows,
    internalized,
    asked,
    pulls,
    changes,
    fetched,
    index,
    names,
    clock,
    intake,
    state,
  };
};

const accountedIn = (d: ReturnType<typeof device>) => async (ops: string[]) =>
  ops.filter((op) => d.stored.get(op) === 'accounted');

beforeEach(() => _resetReceiveState());

describe('receive watcher (owner, 5 Nov 2026: the iPhone showed neither dollar after 20 minutes in front)', () => {
  test('asks for the receive addresses only, from two blocks below the tip (unmined events always come)', async () => {
    const d = device();
    d.watch.foreground(true);
    await d.watch.tick();
    expect(d.asked).toEqual([{ addresses: [RECEIVE], from: 974_207 }]);
    expect(watchFrom(undefined, 1_793_900_000_000)).toBe(1_793_900_000 - 900);
    expect(974_207).toBeLessThan(BLOCK_SCORE_MAX);
    d.watch.stop();
  });

  test('a new payment is shown as pending at once, taken in once through the shared intake, and recorded', async () => {
    const d = device();
    const p = payment(6_065_200);
    d.beefs.set(p.txid, p.beef);
    d.rows.push({ outpoint: `${p.txid}.1`, score: 1_793_900_000.1 });
    d.watch.foreground(true);
    const r = await d.watch.tick();
    expect(r).toMatchObject({ taken: 1, shown: 1, pulled: false });
    expect(d.internalized).toEqual([{ txid: p.txid, outputs: [1] }]);
    expect(d.processed.has(p.txid)).toBe(true); // the full sync skips it
    expect(d.changes).toEqual([0, 1]); // once when shown, once when in
    // Storage holds it now: the balance counts it there, and still shows it as pending (not mined).
    expect(await arrivingNow(accountedIn(d))).toEqual({ counted: 0, pending: 6_065_200 });
    expect(arrivingSats()).toBe(0);
    d.watch.stop();
  });

  test('repeats are skipped: no second fetch or internalize, on later looks or after the full sync took it', async () => {
    const d = device();
    const p = payment(1_000_000);
    d.beefs.set(p.txid, p.beef);
    d.rows.push({ outpoint: `${p.txid}.1`, score: 1_793_900_000.1 }, { outpoint: `${p.txid}_1`, score: 974_209.5 });
    d.watch.foreground(true);
    await d.watch.tick();
    await d.watch.tick();
    await d.watch.tick();
    expect(d.internalized.length).toBe(1);
    // Another payment the full sync already took in (processed), though this storage view lacks it: not refetched.
    const q = payment(5_000);
    d.processed.add(q.txid);
    d.rows.push({ outpoint: `${q.txid}.1`, score: 1_793_900_001 });
    await d.watch.tick();
    expect(d.fetched).toEqual([p.txid]);
    expect(d.internalized.length).toBe(1);
    d.watch.stop();
  });

  test('a spent output is never taken in; spent by a transaction we do not hold, it asks for a pull (throttled)', async () => {
    const d = device();
    const p = payment(6_057_302);
    d.beefs.set(p.txid, p.beef);
    const sweptBy = 'a1972e3f80de9847015a784e3bedfecf61fe8e20f9eb505e494f6b2b349ceab5';
    d.rows.push(
      { outpoint: `${p.txid}.1`, score: 974_206.1 },
      { outpoint: `${p.txid}.1`, score: 1_793_900_598, spendTxid: sweptBy },
    );
    d.watch.foreground(true);
    const r1 = await d.watch.tick();
    expect(r1.pulled).toBe(true);
    expect(d.internalized.length).toBe(0);
    expect(d.pulls.length).toBe(1);
    d.clock.t += PULL_THROTTLE_MS - 1;
    expect((await d.watch.tick()).pulled).toBe(false); // throttled
    d.clock.t += 1;
    expect((await d.watch.tick()).pulled).toBe(true); // the other device may not have pushed yet: asked again
    // The pull brought the sweep in: nothing more to ask.
    d.knownTx.add(sweptBy);
    d.clock.t += PULL_THROTTLE_MS;
    expect((await d.watch.tick()).pulled).toBe(false);
    expect(d.pulls.length).toBe(2);
    d.watch.stop();
  });

  test('H1: the owner stream lists it unspent but the spend index names a spender: not fetched, not shown, pull asked', async () => {
    const d = device();
    const p = payment(6_000_000);
    d.beefs.set(p.txid, p.beef);
    d.rows.push({ outpoint: `${p.txid}.1`, score: 1_793_900_000 });
    d.index.set(`${p.txid}.1`, 'b'.repeat(64));
    d.watch.foreground(true);
    const r = await d.watch.tick();
    expect(r).toMatchObject({ taken: 0, shown: 0, pulled: true, spent: 1 });
    expect(d.fetched).toEqual([]);
    expect(arrivingSats()).toBe(0);
    d.watch.stop();
  });

  test('the spend check cannot answer: nothing is taken in or shown; the next look tries again', async () => {
    const d = device();
    const p = payment(1_500_000);
    d.beefs.set(p.txid, p.beef);
    d.rows.push({ outpoint: `${p.txid}.1`, score: 1_793_900_000 });
    let down = true;
    d.deps.spends = makeSpendCheck({
      index: async (b) => {
        if (down) throw new Error('index 503');
        return b.map(() => null);
      },
    });
    d.watch.foreground(true);
    expect((await d.watch.tick()).shown).toBe(0);
    expect(d.fetched).toEqual([]);
    down = false;
    expect((await d.watch.tick()).taken).toBe(1);
    d.watch.stop();
  });

  test('our own sweep of a receive output never asks for a pull', async () => {
    const d = device();
    const sweep = 'f8e91f14901061a0b0cbd8dc36b2a053fc994fa5eede6fd85c3de13309f399c4';
    d.knownTx.add(sweep);
    d.rows.push({ outpoint: `${'3c'.repeat(32)}.0`, score: 974_204.1, spendTxid: sweep });
    d.watch.foreground(true);
    expect((await d.watch.tick()).pulled).toBe(false);
    d.watch.stop();
  });

  test('does nothing in the background, after the lease runs out, or when the remote store is active', async () => {
    const d = device();
    const p = payment(1_000_000);
    d.beefs.set(p.txid, p.beef);
    d.rows.push({ outpoint: `${p.txid}.1`, score: 1_793_900_000 });
    expect((await d.watch.tick()).skipped).toBe('background'); // never foregrounded
    d.watch.foreground(true);
    d.watch.foreground(false);
    expect((await d.watch.tick()).skipped).toBe('background');
    d.watch.foreground(true);
    d.clock.t += FOREGROUND_LEASE_MS + 1; // the page vanished without APP_BACKGROUND
    expect((await d.watch.tick()).skipped).toBe('background');
    const remote = device({ active: false });
    remote.rows.push(...d.rows);
    remote.beefs.set(p.txid, p.beef);
    remote.watch.foreground(true);
    expect((await remote.watch.tick()).skipped).toBe('inactive');
    expect(d.asked.length + remote.asked.length).toBe(0);
    expect(d.internalized.length + remote.internalized.length).toBe(0);
    d.watch.stop();
    remote.watch.stop();
  });

  test('racing the full sync: the payment is taken in once', async () => {
    for (let i = 0; i < 5; i++) {
      const d = device();
      const p = payment(2_000_000 + i);
      d.beefs.set(p.txid, p.beef);
      d.rows.push({ outpoint: `${p.txid}.1`, score: 1_793_900_000 });
      d.watch.foreground(true);
      // The full sync's coins part found it in the same seconds and takes it in through the same intake.
      const [fromSync] = await Promise.all([d.intake.take(p.txid, Array.from(p.beef)), d.watch.tick()]);
      expect(d.internalized.length).toBe(1);
      expect(['taken', 'already']).toContain(fromSync);
      // L1: whichever took it, it no longer counts as arriving (storage has it).
      expect(arrivingSats()).toBe(0);
      d.watch.stop();
    }
  });

  test('L4: a transaction storage refuses backs off (shared back-off), never retried every look', async () => {
    const d = device();
    const p = payment(1_000_000);
    d.beefs.set(p.txid, p.beef);
    d.rows.push({ outpoint: `${p.txid}.1`, score: 1_793_900_000 });
    const backoff = createInternalizeBackoff(() => d.clock.t);
    let tries = 0;
    const w = createReceiveWatch({
      ...d.deps,
      backoff,
      intake: async () => ({
        coins: d.intake.coins,
        take: async () => {
          tries++;
          throw new Error('target transaction of internalizeAction has invalid status failed.');
        },
      }),
    });
    w.foreground(true);
    await w.tick();
    d.clock.t += 60_000;
    await w.tick();
    expect(tries).toBe(1);
    expect(d.fetched.length).toBe(1);
    expect(backoff.due(p.txid)).toBe(false);
    w.stop();
  });

  test('L5: a site action that starts while the payment downloads: no internalize between its steps', async () => {
    const d = device();
    const p = payment(1_000_000);
    d.rows.push({ outpoint: `${p.txid}.1`, score: 1_793_900_000 });
    d.deps.fetchBeef = async () => {
      d.state.active = false; // chainActive() turned true meanwhile
      return Array.from(p.beef);
    };
    const w = createReceiveWatch(d.deps);
    w.foreground(true);
    expect((await w.tick()).taken).toBe(0);
    expect(d.internalized).toEqual([]);
    w.stop();
  });

  test('mined receipts stop being pending; an output spent on chain stops being arriving', async () => {
    const d = device();
    const p = payment(3_000_000);
    d.beefs.set(p.txid, p.beef);
    d.rows.push({ outpoint: `${p.txid}.1`, score: 1_793_900_000 });
    d.watch.foreground(true);
    await d.watch.tick();
    expect((await arrivingNow(accountedIn(d))).pending).toBe(3_000_000);
    d.rows[0] = { outpoint: `${p.txid}.1`, score: 974_210.2 };
    await d.watch.tick();
    expect((await arrivingNow(accountedIn(d))).pending).toBe(0);
    // Seen pending again, then the app went to the background; back in front, the block is older than the window.
    const q = payment(4_000_000);
    d.beefs.set(q.txid, q.beef);
    d.rows.push({ outpoint: `${q.txid}.1`, score: 1_793_900_100 });
    await d.watch.tick();
    expect((await arrivingNow(accountedIn(d))).pending).toBe(4_000_000);
    d.rows.length = 0;
    await d.watch.tick();
    expect((await arrivingNow(accountedIn(d))).pending).toBe(0);
    d.watch.stop();
  });
});

describe('M4: names and other 1-sat items never cost a download, and payments come first', () => {
  test('a name transaction is never fetched; payments behind a minting session are fetched first, a few per look', async () => {
    const d = device();
    for (let i = 0; i < 20; i++) {
      const n = (i + 1).toString(16).padStart(64, '0');
      d.names.add(n);
      d.rows.push({ outpoint: `${n}.0`, score: 1_793_900_000 + i });
    }
    const pays = Array.from({ length: FETCHES_PER_LOOK + 1 }, (_, i) => payment(1_000_000 + i));
    for (const p of pays) {
      d.beefs.set(p.txid, p.beef);
      d.rows.push({ outpoint: `${p.txid}.1`, score: 1_793_900_100 });
    }
    d.watch.foreground(true);
    const r1 = await d.watch.tick();
    expect(r1.taken).toBe(FETCHES_PER_LOOK); // capped per look
    expect(d.fetched.every((t) => !d.names.has(t))).toBe(true);
    await d.watch.tick();
    expect(d.internalized.length).toBe(pays.length);
    expect(d.fetched.length).toBe(pays.length); // each payment once, no name ever
    d.watch.stop();
  });
});

describe('M3: one hang or a rate limit never stops the watcher, and never runs up requests', () => {
  test('a failed look backs off 3 s doubling to 60 s; a 429 waits longer; a good look resets it', async () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => lookDelay(n, false))).toEqual([3_000, 6_000, 12_000, 24_000, 48_000, 60_000]);
    expect(lookDelay(1, true)).toBe(RATE_LIMITED_MS);
    expect(lookDelay(9, true)).toBe(MAX_BACKOFF_MS);
    const d = device();
    let fail: Error | null = Object.assign(new Error('Too Many Requests'), { status: 429 });
    const w = createReceiveWatch({
      ...d.deps,
      stream: () =>
        (async function* () {
          if (fail) throw fail;
          yield* [] as WatchRow[];
        })(),
    });
    w.foreground(true);
    expect((await w.tick()).skipped).toBe('failed');
    expect(w.state().nextDelay).toBe(RATE_LIMITED_MS);
    fail = new Error('fetch failed');
    await w.tick();
    expect(w.state().nextDelay).toBe(WATCH_INTERVAL_MS * 2);
    fail = null;
    await w.tick();
    expect(w.state()).toMatchObject({ failures: 0, nextDelay: WATCH_INTERVAL_MS });
    w.stop();
  });

  test('a stream that never ends is aborted, and the next look runs', async () => {
    const d = device();
    const signals: AbortSignal[] = [];
    const w = createReceiveWatch({
      ...d.deps,
      timeouts: { streamMs: 20 },
      stream: (_a, _f, signal) => {
        signals.push(signal);
        return (async function* () {
          await new Promise<void>((_, no) => signal.addEventListener('abort', () => no(new Error('aborted'))));
          yield* [] as WatchRow[];
        })();
      },
    });
    w.foreground(true);
    expect((await w.tick()).skipped).toBe('failed');
    expect(signals[0].aborted).toBe(true);
    expect((await w.tick()).skipped).toBe('failed');
    expect(signals.length).toBe(2);
    w.stop();
  });

  test('a tip lookup that hangs: the look goes on with the last 15 minutes of unmined events', async () => {
    const d = device();
    const w = createReceiveWatch({
      ...d.deps,
      timeouts: { fromMs: 20 },
      from: () => new Promise<number>(() => undefined),
    });
    w.foreground(true);
    expect((await w.tick()).skipped).toBeUndefined();
    expect(d.asked[0].from).toBe(watchFrom(undefined, d.clock.t));
    w.stop();
  });

  test('ownerSyncReader: reads the rows, stops at done, throws a 429 with its status, and aborts the request', async () => {
    const enc = new TextEncoder();
    const body = (chunks: string[], hang = false) =>
      new ReadableStream<Uint8Array>({
        start(c) {
          for (const x of chunks) c.enqueue(enc.encode(x));
          if (!hang) c.close();
        },
      });
    const urls: string[] = [];
    const ok = ownerSyncReader('https://api.1sat.app/1sat/owner', async (u) => {
      urls.push(String(u));
      return new Response(
        body([
          'data: {"outpoint":"aa.0","score":1}\n\n',
          'event: sync\ndata: {"phase":"ingest"}\n\n',
          'data: {"outpoint":"bb.1","score":2,"spendTxid":"cc"}\n\nevent: done\ndata: {}\n\n',
        ]),
      );
    });
    const got: WatchRow[] = [];
    for await (const r of ok(['1A', '1B'], 974_207, new AbortController().signal)) got.push(r);
    expect(got).toEqual([
      { outpoint: 'aa.0', score: 1 },
      { outpoint: 'bb.1', score: 2, spendTxid: 'cc' },
    ]);
    expect(urls[0]).toBe('https://api.1sat.app/1sat/owner/sync?owner=1A&owner=1B&from=974207');
    const limited = ownerSyncReader('x', async () => new Response('', { status: 429 }));
    await expect(limited([], 1, new AbortController().signal).next()).rejects.toMatchObject({ status: 429 });
    let passed: AbortSignal | undefined;
    const hung = ownerSyncReader('x', async (_u, init) => {
      passed = init?.signal ?? undefined;
      return new Response(body(['data: {"outpoint":"aa.0","score":1}\n\n'], true));
    });
    const ctl = new AbortController();
    const it = hung([], 1, ctl.signal);
    await it.next();
    ctl.abort();
    expect(passed?.aborted).toBe(true);
  });

  test('the loop: looks every ~3 s while in front, stops on APP_BACKGROUND', async () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const d = device();
    let cleared = 0;
    const w = createReceiveWatch({
      ...d.deps,
      setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
      clearTimer: () => void cleared++,
    });
    w.foreground(true);
    expect(timers.map((t) => t.ms)).toEqual([0]);
    w.foreground(true); // a heartbeat while one is scheduled: no second loop
    expect(timers.length).toBe(1);
    timers[0].fn();
    await new Promise((r) => setTimeout(r, 10));
    expect(d.asked.length).toBe(1);
    expect(timers.map((t) => t.ms)).toEqual([0, WATCH_INTERVAL_MS]);
    w.foreground(false);
    expect(cleared).toBe(1);
    timers[1].fn(); // a timer that fired anyway does nothing
    await new Promise((r) => setTimeout(r, 10));
    expect(d.asked.length).toBe(1);
    w.stop();
  });
});

// Message plumbing only (no money logic): the page tells the worker it is in front. Behaviour of what the worker then
// does is tested above and in initWallet.wiring.test.ts.
describe('the page says when it is in front; only the wallet’s own pages may', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  test('APP_FOREGROUND / APP_BACKGROUND: sent by App.tsx, accepted from extension pages only', () => {
    const bg = read('../background.ts');
    const list = bg.slice(
      bg.indexOf('const noAuthRequired = ['),
      bg.indexOf('if (noAuthRequired.includes(message.action))'),
    );
    expect(list).toContain("'APP_FOREGROUND'");
    expect(list).toContain("'APP_BACKGROUND'");
    const app = read('../App.tsx');
    expect(app).toMatch(/send\('COIN_CHECK_DUE'\);\s*send\('APP_FOREGROUND'\);/);
    expect(app).toMatch(/return send\('APP_BACKGROUND'\)/);
  });
});
