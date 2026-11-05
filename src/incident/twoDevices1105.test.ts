/**
 * Review 20, H1 and M2 (5 Nov 2026): the owner runs one seed on two copies of the wallet. The extension takes a $1
 * payment P in and sweeps it with S about 5 s later; the 1Sat owner stream keeps listing P as unspent until S is mined.
 *
 * H1: the phone's fast intake (its receive watcher, or its now-fast address sync) then took P in as a fresh coin. Its row
 *     is newer than the backup's spent one, so the pull that brings S and S's change C leaves it alone; once C is
 *     admitted the phone counts P and C: 13,999,980 shown for 7,999,980 true (the review's probe).
 * M2: a copy on the remote store (desktop.bwalletx.com) holds P spent by S and C spendable in the shared store, but the
 *     guard asked only the device store, so P still counted as arriving on top of C.
 * The fix asks the 1sat spend index (it sees mempool spends) before anything is taken in or counted as arriving.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { Beef, LockingScript, P2PKH, PrivateKey, Transaction, Utils, type WalletProtocol } from '@bsv/sdk';
import { DEPOSIT_BASKET } from '@1sat/types';
import { FakeStore } from '../testing/fakeWalletStore';
import { balanceSplit } from '../services/depositBalance';
import { accountedVia, outpointStates, knownTxids } from '../services/heldOutpoints';
import { createInternalizeLock } from '../services/internalizeLock';
import { makeCoinIntake, type CoinKey } from '../services/prioritySyncRun';
import { _resetReceiveState, checkReceiveAddresses, setArriving } from '../services/receiveGuard';
import { createPullTrigger, createReceiveWatch, type ReceiveWatchDeps } from '../services/receiveWatch';
import { makeSpendCheck } from '../services/spendCheck';
import { createTakenRecheck } from '../services/takenRecheck';

const key = PrivateKey.fromRandom();
const RECEIVE = key.toPublicKey().toAddress();
const hash = (a: string) => Utils.toHex(Utils.fromBase58Check(a).data as number[]);
const keyByHash = new Map<string, CoinKey>([
  [hash(RECEIVE), { derivationPrefix: '1sat', derivationSuffix: '0', protocolID: [1, 'onesat'] as WalletProtocol }],
]);

const BEFORE = 2_000_000;
const ONE = 6_000_000;
const FEE = 20;
const TRUTH = BEFORE + ONE - FEE; // 7,999,980

/** P: a payment of ONE to the receive address. */
const payment = () => {
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: Utils.toHex(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))),
    sourceOutputIndex: 0,
    unlockingScript: LockingScript.fromHex('00'),
    sequence: 0xffffffff,
  });
  tx.addOutput({ lockingScript: new P2PKH().lock(RECEIVE), satoshis: ONE });
  const beef = new Beef();
  beef.mergeTransaction(tx);
  return { txid: tx.id('hex'), beef: beef.toBinary() };
};
const SWEEP = 'a1972e3f80de9847015a784e3bedfecf61fe8e20f9eb505e494f6b2b349ceab5';

/** The 1sat spend index (POST /spends): it names S for P as soon as S is in the mempool. */
const spendIndex = (spends: Map<string, string>) => async (batch: string[]) =>
  batch.map((o) => spends.get(o.replace('_', '.')) ?? null);

/** The phone: its own store active, $0.42-ish of change, a watcher and an intake as initWallet builds them. */
const phone = (p: { txid: string; beef: number[] }, index: Map<string, string>) => {
  const s = new FakeStore();
  s.out(s.tx('e'.repeat(64), 'completed'), 0, BEFORE, 'default', true);
  const w = s.wallet();
  const processed = new Set<string>();
  const pulls: string[][] = [];
  const read = async () => ({ store: s.held(), userId: 1 });
  const spends = makeSpendCheck({ index: spendIndex(index) });
  const askPull = createPullTrigger({ pull: async () => void pulls.push([...index.values()]), now: () => Date.now() });
  const known = async (txids: string[]) => knownTxids(s.held(), 1, txids);
  const intake = makeCoinIntake({
    wallet: w as never,
    keyByHash,
    processed: { has: async (t) => processed.has(t), add: async (t) => void processed.add(t) },
    lock: createInternalizeLock(),
    spends,
    knownTxids: known,
    foreignSpend: (spenders) => void askPull(spenders),
    unknownSpend: 'skip',
  });
  const deps: ReceiveWatchDeps = {
    active: () => true,
    addresses: () => [RECEIVE],
    from: async () => 974_204,
    // The owner stream still lists P unspent: S is not mined yet.
    stream: () =>
      (async function* () {
        yield { outpoint: `${p.txid}.0`, score: 1_793_900_000.5 };
      })(),
    states: async (ops) => outpointStates(s.held(), 1, ops),
    knownTxids: known,
    processed: async (t) => processed.has(t),
    classify: async (txids) => new Map(txids.map((t) => [t, 'coin' as const])),
    spends,
    askPull,
    fetchBeef: async () => p.beef,
    intake: async () => intake,
    changed: () => undefined,
  };
  return { s, w, read, deps, intake, pulls, accountedFor: accountedVia(read), spends };
};

/** The pull: S and its change C arrive from the backup; C is admitted once the chain knows S. P's row here is newer. */
const pullAndAdmit = (s: FakeStore) => {
  const t = s.tx(SWEEP, 'unproven');
  const c = s.out(t, 0, ONE - FEE, 'default', true, false);
  c.spendable = true; // admitted (the chain knows S, C unspent)
  return c;
};

beforeEach(() => _resetReceiveState());

describe('H1: the second copy never takes in a coin the first copy already swept', () => {
  test('the watcher: P spent by S in the mempool is not taken in, a pull is asked for, and P counts once', async () => {
    const p = payment();
    const index = new Map([[`${p.txid}.0`, SWEEP]]);
    const d = phone(p, index);
    const watch = createReceiveWatch(d.deps);
    watch.foreground(true);
    await watch.tick();
    watch.stop();
    pullAndAdmit(d.s);
    const r = await balanceSplit(d.w, { accountedFor: d.accountedFor });
    expect(r.total).toBe(TRUTH); // was 13,999,980
    expect(d.s.internalized).toEqual([]);
    expect(d.pulls.length).toBe(1);
  });

  test('the shared intake (the address sync uses it too): a coin already spent elsewhere is never taken in', async () => {
    const p = payment();
    const d = phone(p, new Map([[`${p.txid}.0`, SWEEP]]));
    expect(await d.intake.take(p.txid, Array.from(p.beef))).toBe('spent');
    expect(d.s.internalized).toEqual([]);
    expect(d.pulls.length).toBe(1);
    pullAndAdmit(d.s);
    expect((await balanceSplit(d.w, { accountedFor: d.accountedFor })).total).toBe(TRUTH);
  });

  test('the guard: P listed unspent by the owner stream but spent per the spend index never counts as arriving', async () => {
    const p = payment();
    const d = phone(p, new Map([[`${p.txid}.0`, SWEEP]]));
    pullAndAdmit(d.s);
    const r = await checkReceiveAddresses([RECEIVE], {
      ownerSync: () =>
        (async function* () {
          yield { outpoint: `${p.txid}.0`, score: 1_793_900_000.5 };
        })(),
      outputSats: async () => ONE,
      walletOutpoints: async () => [],
      accountedFor: d.accountedFor,
      spends: d.spends,
    });
    expect(r.satoshis).toBe(0);
    setArriving(r.outputs);
    expect((await balanceSplit(d.w, { accountedFor: d.accountedFor })).total).toBe(TRUTH);
  });

  test('an unspent payment is still taken in at once (the check never hides a real one)', async () => {
    const p = payment();
    const d = phone(p, new Map());
    const watch = createReceiveWatch(d.deps);
    watch.foreground(true);
    await watch.tick();
    watch.stop();
    expect(d.s.internalized).toEqual([p.txid]);
    expect(d.s.row(p.txid)?.basket).toBe(DEPOSIT_BASKET);
    expect((await balanceSplit(d.w, { accountedFor: d.accountedFor })).total).toBe(BEFORE + ONE);
  });
});

describe('M2: a copy on the remote store does not count the swept dollar twice', () => {
  test('P spent by S, C spendable in the shared store; the owner stream still lists P: counted once', async () => {
    const p = payment();
    const shared = new FakeStore();
    shared.out(shared.tx('e'.repeat(64), 'completed'), 0, BEFORE, 'default', true);
    const dep = shared.out(shared.tx(p.txid, 'unproven'), 0, ONE, DEPOSIT_BASKET, false);
    shared.sweep(dep, SWEEP, FEE);
    const w = shared.wallet();
    const remoteActive = accountedVia(async () => undefined); // no device store: it names none
    const r = await checkReceiveAddresses([RECEIVE], {
      ownerSync: () =>
        (async function* () {
          yield { outpoint: `${p.txid}.0`, score: 1_793_900_000.5 };
        })(),
      outputSats: async () => ONE,
      walletOutpoints: async () => (await w.listOutputs({ basket: 'default' })).outputs.map((o) => o.outpoint),
      accountedFor: remoteActive,
      spends: makeSpendCheck({ index: spendIndex(new Map([[`${p.txid}.0`, SWEEP]])) }),
    });
    setArriving(r.outputs);
    expect(r.satoshis).toBe(0);
    expect((await balanceSplit(w, { accountedFor: remoteActive })).total).toBe(TRUTH);
  });
});

describe('H1 leftover (review 20 re-check): the index lags, so a swept coin was taken in; one re-check puts it right', () => {
  test('taken in on an "unspent" that was only index lag: 13,999,980 until the re-check, then 7,999,980', async () => {
    const p = payment();
    const s = new FakeStore();
    s.out(s.tx('e'.repeat(64), 'completed'), 0, BEFORE, 'default', true);
    const w = s.wallet();
    const accountedFor = accountedVia(async () => ({ store: s.held(), userId: 1 }));
    // The 1sat index has not seen the extension's sweep yet; WhatsOnChain can't answer.
    const index = new Map<string, string>();
    const spends = makeSpendCheck({
      index: spendIndex(index),
      woc: async () => {
        throw new Error('woc 503');
      },
      wocFor: 'unanswered',
    });
    const pulls: number[] = [];
    const known = async (txids: string[]) => knownTxids(s.held(), 1, txids);
    const recheck = createTakenRecheck({
      spends,
      heldTxids: known,
      // Lower spendability only (initWallet: storage.updateOutput, and the automatic coin check's cleared list).
      markSpent: async (outpoint, spender) => {
        const [txid, vout] = outpoint.split('.');
        const row = s.row(txid, Number(vout));
        if (!row?.spendable) return 0;
        row.spendable = false;
        const by = s.txs.find((t) => t.txid === spender);
        if (by) row.spentBy = by.transactionId;
        return 1;
      },
      askPull: () => (pulls.push(1), true),
    });
    // The address sync's intake (fails open), remembering what it took in on that answer.
    const intake = makeCoinIntake({
      wallet: w as never,
      keyByHash,
      processed: { has: async () => false, add: async () => undefined },
      lock: createInternalizeLock(),
      spends,
      knownTxids: known,
      unknownSpend: 'take',
      onTaken: (ops) => recheck.add(ops),
    });
    expect(await intake.take(p.txid, Array.from(p.beef))).toBe('taken');
    pullAndAdmit(s);
    expect((await balanceSplit(w, { accountedFor })).total).toBe(TRUTH + ONE); // 13,999,980: the reviewer's probe
    // The index catches up; the next watcher look or guard run re-checks what was taken in.
    index.set(`${p.txid}.0`, SWEEP);
    await recheck.run({ force: true });
    expect((await balanceSplit(w, { accountedFor })).total).toBe(TRUTH); // 7,999,980
    expect(pulls.length).toBe(0); // the spender is already here (the pull brought it): nothing more to pull
    expect(recheck.size()).toBe(0);
  });
});
