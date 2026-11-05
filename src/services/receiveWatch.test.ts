import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Beef, LockingScript, P2PKH, PrivateKey, Transaction, Utils, type WalletProtocol } from '@bsv/sdk';
import { DEPOSIT_BASKET } from '@1sat/types';
import { createInternalizeLock } from './internalizeLock';
import { makeCoinIntake, type CoinKey } from './prioritySyncRun';
import { _resetReceiveState, arrivingNow, arrivingSats } from './receiveGuard';
import type { OutpointState } from './heldOutpoints';
import {
  BLOCK_SCORE_MAX,
  FOREGROUND_LEASE_MS,
  PULL_THROTTLE_MS,
  WATCH_INTERVAL_MS,
  createReceiveWatch,
  watchFrom,
  type ReceiveWatchDeps,
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
  const intake = makeCoinIntake({ wallet: wallet as never, keyByHash, processed: store, lock });
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
    knownTxids: async (txids) => new Set(txids.filter((t) => knownTx.has(t))),
    processed: async (t) => processed.has(t),
    fetchBeef: async (t) => {
      const b = beefs.get(t);
      if (!b) throw new Error('no beef');
      return b;
    },
    intake: async () => intake,
    pull: async () => void pulls.push(clock.t),
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
    clock,
    intake,
    state,
  };
};

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
    const accounted = async (ops: string[]) => ops.filter((op) => d.stored.get(op) === 'accounted');
    expect(await arrivingNow(accounted)).toEqual({ counted: 0, pending: 6_065_200 });
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
    let fetched = 0;
    d.deps.fetchBeef = async () => (fetched++, q.beef);
    await d.watch.tick();
    expect(fetched).toBe(0);
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
      const [fromSync] = await Promise.all([d.intake.take(p.txid, p.beef), d.watch.tick()]);
      expect(d.internalized.length).toBe(1);
      expect(['taken', 'already']).toContain(fromSync);
      d.watch.stop();
    }
  });

  test('a fetch that fails is retried after a pause; a transaction with no plain coin is left to the full sync', async () => {
    const d = device();
    const p = payment(1_000_000);
    d.rows.push({ outpoint: `${p.txid}.1`, score: 1_793_900_000 });
    d.watch.foreground(true);
    await d.watch.tick(); // no BEEF yet
    d.beefs.set(p.txid, p.beef);
    await d.watch.tick();
    expect(d.internalized.length).toBe(0); // waiting out RETRY_AFTER_MS
    d.clock.t += 30_000;
    await d.watch.tick();
    expect(d.internalized.length).toBe(1);
    // A 1-sat item at the receive address: fetched once, never taken in here.
    const one = payment(1);
    let fetched = 0;
    d.deps.fetchBeef = async () => (fetched++, one.beef);
    d.rows.push({ outpoint: `${one.txid}.1`, score: 1_793_900_002 });
    await d.watch.tick();
    await d.watch.tick();
    expect(fetched).toBe(1);
    expect(d.internalized.length).toBe(1);
    d.watch.stop();
  });

  test('mined receipts stop being pending; an output spent on chain stops being arriving', async () => {
    const d = device();
    const p = payment(3_000_000);
    d.beefs.set(p.txid, p.beef);
    d.rows.push({ outpoint: `${p.txid}.1`, score: 1_793_900_000 });
    d.watch.foreground(true);
    await d.watch.tick();
    const accounted = async (ops: string[]) => ops.filter((op) => d.stored.get(op) === 'accounted');
    expect((await arrivingNow(accounted)).pending).toBe(3_000_000);
    d.rows[0] = { outpoint: `${p.txid}.1`, score: 974_210.2 };
    await d.watch.tick();
    expect((await arrivingNow(accounted)).pending).toBe(0);
    // Seen pending again, then the app went to the background; back in front, the block is older than the window.
    const q = payment(4_000_000);
    d.beefs.set(q.txid, q.beef);
    d.rows.push({ outpoint: `${q.txid}.1`, score: 1_793_900_100 });
    await d.watch.tick();
    expect((await arrivingNow(accounted)).pending).toBe(4_000_000);
    d.rows.length = 0;
    await d.watch.tick();
    expect((await arrivingNow(accounted)).pending).toBe(0);
    d.watch.stop();
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

describe('receive watcher wiring (initWallet, background, App)', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  test('one internalize lock across the address sync, the receive guard and the watcher; the same intake', () => {
    const init = read('../initWallet.ts');
    expect(init).toMatch(/runPrioritySync\(actionCtx, \{\s*count: scanPlan\.count,\s*lock: internalizeLock,/);
    expect(init).toMatch(/const r = await internalizeLock\(async \(\) => \{/); // the guard, re-checking inside
    expect(init).toMatch(/makeCoinIntake\(\{\s*wallet: actionCtx\.wallet,[\s\S]*?lock: internalizeLock,/);
    expect(init).toContain(
      'active: () => syncsOpen && !walletClosed && storage.isActiveStorageProvider() && !chainActive()',
    );
    expect(init).toMatch(
      /admitPrompt = \{ from: Date\.now\(\), until: Date\.now\(\) \+ PROMPT_ADMIT_MS \};\s*return deviceSync\.syncNow\(\);/,
    );
    expect(init).toMatch(/admitPending\(device, identityKey, stopBackupCheck\.verifier, \{ prompt: admitPrompt \}\)/);
    expect(init).toContain('receiveWatch.stop();');
  });
  test('the page says when it is in front; only the wallet’s own pages may', () => {
    const bg = read('../background.ts');
    const list = bg.slice(
      bg.indexOf('const noAuthRequired = ['),
      bg.indexOf('if (noAuthRequired.includes(message.action))'),
    );
    expect(list).toContain("'APP_FOREGROUND'");
    expect(list).toContain("'APP_BACKGROUND'");
    expect(bg).toMatch(
      /case 'APP_FOREGROUND':\s*case 'APP_BACKGROUND':\s*\/\/[^\n]*\n\s*setAppFront\(message\.action === 'APP_FOREGROUND'\)/,
    );
    expect(bg).toContain('if (appInFront()) ctx.receiveWatch.foreground(true);');
    const app = read('../App.tsx');
    expect(app).toMatch(/send\('COIN_CHECK_DUE'\);\s*send\('APP_FOREGROUND'\);/);
    expect(app).toMatch(/return send\('APP_BACKGROUND'\)/);
    expect(app).toMatch(
      /setInterval\(\(\) => \{\s*if \(document\.visibilityState !== 'hidden'\) send\('APP_FOREGROUND'\);\s*\}, 30_000\)/,
    );
  });
});
