/**
 * INCIDENT (6-7 Nov 2026, the owner's iPhone, build 6c7b2275): every push to wallet.1sat.app failed with
 *   [deviceActive] the merge did not complete: WERR_INTERNAL: An internal error has occurred. · in processSyncChunk
 *   (provenTxs 3, transactions 4, outputs 47, txLabelMaps 4, provenTxReqs 6, user, longest provenTxReqs.rawTx 2485)
 * so ~$0.60 of change and the seals made since lived only on the phone.
 *
 * Cause: 34 of the page's 47 outputs belonged to transactions the phone took in from the backup (pulled at ~02:36 on
 * 6 Nov, with the backup's times from 3-5 Nov). A pull keeps the sender's time, so no push from the backup's cursor
 * ever carried them, and the backup's sync map for this phone has no id for them. The phone's admission then wrote
 * their coins (spendable, 07:46-07:47), so the coins went in the push without their transactions. The backup's
 * EntityOutput.mergeFind files a coin under syncMap.transaction.idMap[transactionId], gets undefined and queries with
 * it: knex refuses, the server answers WERR_INTERNAL. The carrier that should have sent the parents was gated on the
 * account's registration and sent none (the logged page holds 4 transactions, not 20).
 *
 * Real wallet-toolbox: two StorageIdb stores on fake-indexeddb, the phone and a stand-in for wallet.1sat.app that
 * merges with the toolbox's own processSyncChunk (the same EntityOutput.mergeFind; IndexedDB refuses the undefined id
 * as knex does). The push is the toolbox's syncToWriter, as setActive's propagate and updateBackups run it. The inbound
 * guard is installed as initWallet installs it, with no store registered (the phone's state on 7 Nov). No keys.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PrivateKey, Random, Utils } from '@bsv/sdk';
import { StorageIdb, StorageProvider, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import * as IS from '../services/inboundSync';
import { _forgetPushMemory, _resetPushPasses, addMissingParents, type ParentStore } from '../services/pushParents';

const READER = Symbol.for('bwx.inboundSync.reader');
const DAY = 86_400_000;
const EPOCH = 0;
const svc = {
  chain: 'main',
  getChainTracker: async () => ({ isValidRootForHeight: async () => true }),
  getHeaderForHeight: async () => new Array(80).fill(0),
} as never;

let dbn = 0;
async function idb(name: string) {
  const s = new StorageIdb(StorageProvider.createStorageBaseOptions('main'));
  const n = `pushparents-${name}-${++dbn}`; // its own names: fake-indexeddb is shared across files
  (s as unknown as { dbName: string }).dbName = n;
  await s.migrate(n, `sik-${n}`);
  await s.makeAvailable();
  s.setServices(svc);
  return s;
}

type Row = Record<string, unknown>;
type Page = Record<string, Row[] | undefined>;
const hex = () => Utils.toHex(Random(32));
const bytes = (n: number) => Array.from(Random(n));
const txRow = (userId: number, id: number, txid: string, at: Date, extra: Row = {}) => ({
  created_at: at,
  updated_at: at,
  transactionId: id,
  userId,
  status: 'unproven',
  reference: Utils.toBase64(Random(9)),
  isOutgoing: true,
  satoshis: -75,
  description: 'a test payment',
  version: 1,
  lockTime: 0,
  txid,
  rawTx: bytes(200),
  ...extra,
});
const outRow = (
  userId: number,
  id: number,
  transactionId: number,
  txid: string,
  vout: number,
  at: Date,
  x: Row = {},
) => ({
  created_at: at,
  updated_at: at,
  outputId: id,
  userId,
  transactionId,
  basketId: 1,
  spendable: false,
  change: true,
  vout,
  satoshis: 5000 + vout,
  providedBy: 'storage',
  purpose: 'change',
  type: 'P2PKH',
  txid,
  outputDescription: '',
  scriptLength: 25,
  scriptOffset: 0,
  lockingScript: bytes(25),
  ...x,
});
const ms = (d: unknown) => (d instanceof Date ? d.getTime() : new Date(d as string).getTime());

async function world() {
  const identityKey = PrivateKey.fromRandom().toPublicKey().toString();
  const phone = await idb('phone');
  const server = await idb('server');
  IS._mergeUnchecked(server); // wallet.1sat.app merges with the toolbox's own code
  const pu = (await phone.findOrInsertUser(identityKey)).user.userId;
  const su = (await server.findOrInsertUser(identityKey)).user.userId;
  const pages: Page[] = [];
  /** Per captured page: the pass it belongs to (its cursor) and whether the backup refused it. */
  const passOf = new WeakMap<Page, { since: number; refused: boolean }>();
  const s = server as unknown as { processSyncChunk: (a: unknown, c: Page) => Promise<{ done: boolean }> };
  const merge = s.processSyncChunk.bind(server);
  let yieldAfter: number | undefined;
  /** A fault on the n-th page (from 1): refused, committed but its answer lost (a timeout), or the app killed after it. */
  let fault: { at: number; kind: 'refuse' | 'timeoutCommitted' | 'kill' } | undefined;
  let pageNo = 0;
  s.processSyncChunk = async (a, c) => {
    pages.push(
      Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Array.isArray(v) ? v.map((r) => ({ ...r })) : v])),
    );
    const f = fault && ++pageNo === fault.at ? fault.kind : undefined;
    if (f) fault = undefined; // once
    const meta = { since: ms((a as { since?: unknown }).since ?? 0), refused: f === 'refuse' };
    passOf.set(pages[pages.length - 1], meta);
    if (f === 'refuse') throw new Error('network: the backup refused the page');
    const r = await merge(a, c);
    if (f === 'timeoutCommitted') throw new Error('network: the backup did not answer in time (processSyncChunk)');
    if (f === 'kill' && !r.done) return { ...r, done: true }; // the run ends here; the test relaunches the app
    // An own payment waiting (pushView, perf/phone-seal-speed): a committed page is answered as the last one.
    if (yieldAfter !== undefined && --yieldAfter <= 0 && !r.done) {
      yieldAfter = undefined;
      return { ...r, done: true };
    }
    return r;
  };
  const sm = new WalletStorageManager(identityKey, phone, [server]);
  const push = () => sm.syncToWriter({ identityKey, userId: su }, server as never, phone as never);
  /** The push as build 6c7b2275 sent it on the phone: no parents. */
  const withoutCarrier = async <T>(fn: () => Promise<T>) => {
    const p = phone as unknown as Record<string, unknown>;
    p.getSyncChunk = (StorageIdb.prototype as unknown as Record<symbol, unknown>)[READER];
    try {
      return await fn();
    } finally {
      delete p.getSyncChunk;
    }
  };
  const faultAt = (at: number, kind: 'refuse' | 'timeoutCommitted' | 'kill') => {
    fault = { at, kind };
    pageNo = 0;
  };
  return {
    identityKey,
    phone,
    server,
    pu,
    su,
    pages,
    push,
    withoutCarrier,
    yieldOnce: () => void (yieldAfter = 1),
    faultAt,
    passOf,
  };
}
type World = Awaited<ReturnType<typeof world>>;

/**
 * The phone's own payment, pushed; then `n` transactions of `per` coins each that the extension made and the phone
 * took in from the backup with the backup's older times; then the phone's admission writes their coins.
 */
async function pulledThenAdmitted(w: World, n: number, per: number) {
  const now = Date.now();
  const T0 = new Date(now - 4 * DAY);
  const T1 = new Date(now - DAY);
  await w.phone.insertTransaction(txRow(w.pu, 10, hex(), T1) as never);
  await w.phone.insertOutput(outRow(w.pu, 100, 10, hex(), 0, T1, { spendable: true }) as never);
  await w.push();
  const pulled: { phoneTx: number; serverTx: number; txid: string; outputs: number[] }[] = [];
  for (let i = 0; i < n; i++) {
    const txid = hex();
    const p = { phoneTx: 1000 + i, serverTx: 5000 + i, txid, outputs: [] as number[] };
    await w.server.insertTransaction(txRow(w.su, p.serverTx, txid, T0, { status: 'completed' }) as never);
    await w.phone.insertTransaction(txRow(w.pu, p.phoneTx, txid, T0, { status: 'completed' }) as never);
    for (let v = 0; v < per; v++) {
      await w.server.insertOutput(outRow(w.su, 50_000 + i * 10 + v, p.serverTx, txid, v, T0) as never);
      const id = 10_000 + i * 10 + v;
      await w.phone.insertOutput(outRow(w.pu, id, p.phoneTx, txid, v, T0) as never);
      p.outputs.push(id);
    }
    pulled.push(p);
  }
  for (const p of pulled) for (const id of p.outputs) await w.phone.updateOutput(id, { spendable: true });
  return { pulled, since: T1 };
}

const serverCoin = async (w: World, txid: string, vout: number) =>
  (await w.server.findOutputs({ partial: { txid, vout } }))[0];

beforeAll(() => {
  IS._resetInboundVerifiers();
  IS.installInboundSyncGuard(StorageIdb);
});
beforeEach(async () => {
  await _resetPushPasses();
});
afterAll(() => IS._resetInboundVerifiers());

describe('a push page carries the rows its own are filed under', () => {
  test('(a) coins of pulled transactions: refused without their parents, filed with them', async () => {
    const w = await world();
    const { pulled } = await pulledThenAdmitted(w, 2, 2);
    // The fixture reproduces the phone: the toolbox refuses the page on the coin's undefined transaction id.
    await expect(w.withoutCarrier(() => w.push())).rejects.toThrow(/transactionId/);
    expect((await serverCoin(w, pulled[0].txid, 0)).spendable).toBe(false);

    await w.push();
    for (const p of pulled) for (let v = 0; v < 2; v++) expect((await serverCoin(w, p.txid, v)).spendable).toBe(true);
    // Filed under the backup's own rows: no transaction or coin was inserted twice.
    for (const p of pulled) {
      expect(await w.server.findTransactions({ partial: { txid: p.txid } })).toHaveLength(1);
      expect(await w.server.findOutputs({ partial: { txid: p.txid } })).toHaveLength(2);
    }
  });

  test('(b) a parent already on the page is not added again', async () => {
    const w = await world();
    const { pulled } = await pulledThenAdmitted(w, 1, 1);
    const own = hex();
    await w.phone.insertTransaction(txRow(w.pu, 30, own, new Date()) as never);
    await w.phone.insertOutput(outRow(w.pu, 300, 30, own, 0, new Date(), { spendable: true }) as never);
    w.pages.length = 0;
    await w.push();
    const ids = w.pages.flatMap((p) => (p.transactions ?? []).map((t) => t.transactionId));
    expect(ids.filter((id) => id === 30)).toHaveLength(1);
    expect(ids.filter((id) => id === pulled[0].phoneTx)).toHaveLength(1);
    for (const p of w.pages) {
      const onPage = (p.transactions ?? []).map((t) => t.transactionId);
      expect(new Set(onPage).size).toBe(onPage.length);
    }
  });

  test('(c) an added parent changes no time or status, on the backup or the phone (the phone writes nothing)', async () => {
    const w = await world();
    const { pulled } = await pulledThenAdmitted(w, 1, 1);
    const p = pulled[0];
    // Clocks disagree: the backup's copy is completed at a time *older* than the phone's unproven copy. A plain copy of
    // the phone's row would be "newer" and set the backup back to unproven.
    await w.server.updateTransaction(p.serverTx, {
      status: 'completed',
      updated_at: new Date(Date.now() - 5 * DAY),
    } as never);
    await w.phone.updateTransaction(p.phoneTx, {
      status: 'unproven',
      updated_at: new Date(Date.now() - 4 * DAY),
    } as never);
    const before = (await w.server.findTransactions({ partial: { transactionId: p.serverTx } }))[0];
    const snapshot = async () =>
      JSON.stringify([
        (await w.phone.findTransactions({ partial: {} })).map((t) => [t.transactionId, t.status, ms(t.updated_at)]),
        (await w.phone.findOutputs({ partial: {} })).map((o) => [o.outputId, o.spendable, o.spentBy, ms(o.updated_at)]),
      ]);
    const phoneBefore = await snapshot();
    w.pages.length = 0;
    await w.push();
    const after = (await w.server.findTransactions({ partial: { transactionId: p.serverTx } }))[0];
    expect(after.status).toBe('completed');
    expect(ms(after.updated_at)).toBe(ms(before.updated_at));
    expect(after.rawTx).toEqual(before.rawTx);
    expect(await snapshot()).toBe(phoneBefore);
    // On the wire: the phone's status as it holds it, the epoch as its time (never refreshed), no proof id.
    const sent = w.pages.flatMap((pg) => pg.transactions ?? []).find((t) => t.transactionId === p.phoneTx)!;
    expect(sent.status).toBe('unproven');
    expect(ms(sent.updated_at)).toBe(EPOCH);
    expect(sent.provenTxId).toBeUndefined();
  });

  /** Every row the pass owes (changed at or after its cursor) went exactly once, as itself (never as an epoch copy). */
  const expectEachOnce = async (w: World, since: Date) => {
    const owed = {
      transactions: (await w.phone.findTransactions({ partial: { userId: w.pu }, since })).map((t) => t.transactionId),
      outputs: (await w.phone.findOutputs({ partial: { userId: w.pu }, since })).map((o) => o.outputId),
    };
    for (const [key, idKey] of [
      ['transactions', 'transactionId'],
      ['outputs', 'outputId'],
    ] as const) {
      const sent = w.pages.flatMap((p) => (p[key] ?? []).filter((r) => ms(r.updated_at) >= since.getTime()));
      const count = new Map<unknown, number>();
      for (const r of sent) count.set(r[idKey], (count.get(r[idKey]) ?? 0) + 1);
      for (const id of owed[key]) expect([key, id, count.get(id)]).toEqual([key, id, 1]);
      expect(sent).toHaveLength(owed[key].length);
    }
  };

  test('(d) over many pages, with the parents share cutting pages short, every row goes exactly once', async () => {
    const w = await world();
    const { pulled, since } = await pulledThenAdmitted(w, 60, 1);
    for (let i = 0; i < 6; i++) {
      const txid = hex();
      await w.phone.insertTransaction(txRow(w.pu, 30 + i, txid, new Date()) as never);
      for (let v = 0; v < 2; v++)
        await w.phone.insertOutput(
          outRow(w.pu, 300 + i * 10 + v, 30 + i, txid, v, new Date(), { spendable: true }) as never,
        );
    }
    w.pages.length = 0;
    await w.push();
    expect(w.pages.length).toBeGreaterThanOrEqual(3);
    // The first page is 64 rows: at most 16 of its additions are parents, so its coins end early.
    expect((w.pages[0].transactions ?? []).filter((t) => ms(t.updated_at) === EPOCH)).toHaveLength(16);
    expect(w.pages[0].outputs!.length).toBeLessThan(64 - 7);
    await expectEachOnce(w, since);
    for (const p of pulled) expect((await serverCoin(w, p.txid, 0)).spendable).toBe(true);
  });

  test('(d) a pass that stops after a page and goes on later still sends every row once, new ones too', async () => {
    const w = await world();
    const { pulled, since } = await pulledThenAdmitted(w, 20, 3);
    const last = pulled[0]; // its coins are on the first page, so that page carries it (as a no-op parent)
    const T0 = new Date(Date.now() - 4 * DAY);
    await w.server.updateTransaction(last.serverTx, { status: 'unproven', updated_at: T0 } as never);
    await w.phone.updateTransaction(last.phoneTx, { status: 'unproven', updated_at: T0 } as never);
    w.pages.length = 0;
    w.yieldOnce(); // an own payment waits: the push ends after its first committed page
    await w.push();
    expect(w.pages).toHaveLength(1);
    // The payment: a new transaction and coin, written while the pass is half done. The backup counted the first page's
    // parents into its transaction offset; without taking them off again this transaction would be skipped.
    // New rows take the next ids, after every row the pass has read (as the store's own ids would).
    const txid = hex();
    await w.phone.insertTransaction(txRow(w.pu, 9_999, txid, new Date()) as never);
    await w.phone.insertOutput(outRow(w.pu, 99_999, 9_999, txid, 0, new Date(), { spendable: true }) as never);
    // Meanwhile the phone learns a pulled transaction is mined: that row joins the pass, at its place among the rows
    // the pass has read (its first page carried it only as a no-op parent).
    await w.phone.updateTransaction(last.phoneTx, { status: 'completed' } as never);
    await w.push();
    await expectEachOnce(w, since);
    expect((await w.server.findTransactions({ partial: { transactionId: last.serverTx } }))[0].status).toBe(
      'completed',
    );
    expect(await w.server.findTransactions({ partial: { txid } })).toHaveLength(1);
    expect((await serverCoin(w, txid, 0)).spendable).toBe(true);
    for (const p of pulled) expect((await serverCoin(w, p.txid, 2)).spendable).toBe(true);
  });

  test('a page the backup refused is not counted: the retry sends the same rows', async () => {
    const w = await world();
    const { pulled, since } = await pulledThenAdmitted(w, 3, 1);
    const s = w.server as unknown as { processSyncChunk: (...a: unknown[]) => Promise<unknown> };
    const real = s.processSyncChunk;
    s.processSyncChunk = async () => {
      throw new Error('network: the backup did not answer in time (processSyncChunk)');
    };
    await expect(w.push()).rejects.toThrow(/did not answer/);
    s.processSyncChunk = real;
    w.pages.length = 0;
    await w.push();
    await expectEachOnce(w, since);
    for (const p of pulled) expect((await serverCoin(w, p.txid, 0)).spendable).toBe(true);
  });
});

/**
 * The app relaunches mid-pass (iOS kills it, or a timed-out push then a backgrounding): the pass's memory is gone while
 * the backup's offsets still count the parents earlier pages carried. Review of 13196734: a fresh memory took those
 * offsets as they were, overshot, skipped the rows in between, and the backup's cursor moved past them for good. Now a
 * pass this device has no memory of is read again from its start: rows the backup holds come again as no-ops.
 */
describe('a relaunch in the middle of a push pass skips nothing', () => {
  /** A pass of several pages; a fault on page `at`; the app relaunches; meanwhile a payment and a proof land. */
  const scenario = async (kind: 'refuse' | 'timeoutCommitted' | 'kill', at: number, lost = false) => {
    const w = await world();
    const { pulled, since } = await pulledThenAdmitted(w, 20, 3);
    const first = pulled[0]; // its coins are on the first page, which carries it as a no-op parent
    const T0 = new Date(Date.now() - 4 * DAY);
    await w.server.updateTransaction(first.serverTx, { status: 'unproven', updated_at: T0 } as never);
    await w.phone.updateTransaction(first.phoneTx, { status: 'unproven', updated_at: T0 } as never);
    w.pages.length = 0;
    w.faultAt(at, kind);
    await w.push().catch(() => undefined);
    // The relaunch: this process's memory is gone; the record kept before each page stays (unless `lost`).
    if (lost) await _resetPushPasses();
    else _forgetPushMemory();
    const txid = hex();
    await w.phone.insertTransaction(txRow(w.pu, 9_999, txid, new Date()) as never);
    await w.phone.insertOutput(outRow(w.pu, 99_999, 9_999, txid, 0, new Date(), { spendable: true }) as never);
    await w.phone.updateTransaction(first.phoneTx, { status: 'completed' } as never);
    await w.push();
    // Nothing skipped: every row the pass owes reached the backup, as the phone holds it.
    const owedTx = await w.phone.findTransactions({ partial: { userId: w.pu }, since });
    const owedOut = await w.phone.findOutputs({ partial: { userId: w.pu }, since });
    const sent = (key: string, idKey: string, id: unknown) =>
      w.pages.flatMap((p) => p[key] ?? []).filter((r) => r[idKey] === id && ms(r.updated_at) >= since.getTime()).length;
    for (const t of owedTx)
      expect([t.transactionId, sent('transactions', 'transactionId', t.transactionId) >= 1]).toEqual([
        t.transactionId,
        true,
      ]);
    for (const o of owedOut)
      expect([o.outputId, sent('outputs', 'outputId', o.outputId) >= 1]).toEqual([o.outputId, true]);
    expect((await w.server.findTransactions({ partial: { transactionId: first.serverTx } }))[0].status).toBe(
      'completed',
    );
    expect((await serverCoin(w, txid, 0)).spendable).toBe(true);
    for (const p of pulled) for (let v = 0; v < 3; v++) expect((await serverCoin(w, p.txid, v)).spendable).toBe(true);
    // Re-sent rows were no-ops: one row per transaction and coin on the backup.
    expect(await w.server.findTransactions({ partial: { txid } })).toHaveLength(1);
    for (const p of pulled) expect(await w.server.findOutputs({ partial: { txid: p.txid } })).toHaveLength(3);
    // With the kept record the pass goes on where it was: no coin is read again (a restart from 0 would re-send them
    // and grow the backup's offsets by a whole pass).
    // Counted per pass, over the pages the backup committed (a refused page comes again whole, by design).
    const committedSends = new Map<string, number>();
    for (const pg of w.pages) {
      const m = w.passOf.get(pg);
      if (!m || m.refused) continue;
      for (const o of pg.outputs ?? []) {
        const k = `${m.since}|${String(o.outputId)}`;
        committedSends.set(k, (committedSends.get(k) ?? 0) + 1);
      }
    }
    const twice = [...committedSends].filter(([, n]) => n > 1).map(([k]) => k);
    if (!lost) expect(twice).toEqual([]);
    return { pages: w.pages.length, resent: twice.length };
  };
  for (const kind of ['kill', 'refuse', 'timeoutCommitted'] as const)
    for (const at of [1, 2, 3]) {
      // every page of the pass: two with rows, then its empty last one
      test(`${kind} on page ${at}, then a relaunch: it goes on where it was`, async () => {
        expect((await scenario(kind, at)).pages).toBeGreaterThan(at);
      });
      test(`${kind} on page ${at}, then a relaunch with the record lost: read again, nothing skipped`, async () => {
        expect((await scenario(kind, at, true)).pages).toBeGreaterThan(at);
      });
    }
});

/**
 * A coin whose transaction can't go as a no-op (re-review of 96f2cda1): it must not hold the whole page back. It is
 * taken off the page, logged, and sent once its transaction moves on.
 */
describe('a row whose parent cannot go yet is held back, never the page', () => {
  const stuck = async (status: string, extra: Row = {}) => {
    const w = await world();
    const { pulled } = await pulledThenAdmitted(w, 3, 1);
    const p = pulled[1];
    const T0 = new Date(Date.now() - 4 * DAY);
    await w.server.updateTransaction(p.serverTx, { status, updated_at: T0, ...extra } as never);
    await w.phone.updateTransaction(p.phoneTx, { status, updated_at: T0, ...extra } as never);
    const lines: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    try {
      await w.push(); // the page commits
    } finally {
      spy.mockRestore();
    }
    return { w, p, pulled, lines };
  };

  for (const [status, extra] of [
    ['failed', {}],
    ['nosend', {}],
    ['completed', {}],
  ] as [string, Row][])
    test(`a ${status} transaction goes with its coin`, async () => {
      const { w, p, pulled, lines } = await stuck(status, extra);
      for (const q of pulled) expect((await serverCoin(w, q.txid, 0)).spendable).toBe(true);
      expect(lines.filter((l) => l.includes('held back'))).toEqual([]);
      expect((await w.server.findTransactions({ partial: { transactionId: p.serverTx } }))[0].status).toBe(status);
    });

  for (const [status, extra] of [
    ['unsigned', {}],
    ['unprocessed', {}],
    ['nonfinal', {}],
    ['unfail', {}],
    ['nosend', { noSendExpiryMode: 'blocks' }],
  ] as [string, Row][])
    test(`a ${status}${extra.noSendExpiryMode ? ' (with an expiry)' : ''} transaction: its coin is held back, logged, and sent later`, async () => {
      const { w, p, pulled, lines } = await stuck(status, extra);
      // The page committed: the other coins are filed; this one waits, and the log names it and why.
      for (const q of pulled.filter((q) => q !== p)) expect((await serverCoin(w, q.txid, 0)).spendable).toBe(true);
      expect((await serverCoin(w, p.txid, 0)).spendable).toBe(false);
      expect(lines.filter((l) => l.includes('held back'))).toEqual([
        `[deviceSync] push: coin ${p.txid}:0 held back: its transaction ${p.txid} is ${status}; it goes once that moves on`,
      ]);
      expect((await w.server.findTransactions({ partial: { transactionId: p.serverTx } }))[0].status).toBe(status);
      // A relaunch, then the transaction is mined: the next push carries it in its window, and the held coin with it.
      _forgetPushMemory();
      await w.phone.updateTransaction(p.phoneTx, { status: 'completed', noSendExpiryMode: undefined } as never);
      await w.push();
      expect((await serverCoin(w, p.txid, 0)).spendable).toBe(true);
      expect((await w.server.findTransactions({ partial: { transactionId: p.serverTx } }))[0].status).toBe('completed');
    });
});

/**
 * The page the phone failed on (diag-1107/work/chunk-listing.txt), by the phone's own ids, with made-up txids and
 * bytes. 6 Nov ~02:37: the phone pushes its own rows; it takes in 12 of the extension's transactions with their 3-5 Nov
 * times; then admissions, two seals, proofs and re-stamped proof requests. The first push page is then exactly the
 * logged one: provenTxs 3, transactions 4, outputs 47, txLabelMaps 4, provenTxReqs 6, user.
 */
describe("the phone's 7 Nov page", () => {
  test('refused as logged without parents; with them it carries 16 parents and the push completes', async () => {
    const w = await world();
    const now = Date.now();
    const tOld = new Date(now - 6 * DAY);
    const tExt = new Date(now - 4 * DAY);
    const tOwn = new Date(now - 2 * DAY);
    const txids = new Map<number, string>();
    const txidOf = (id: number) => txids.get(id) ?? (txids.set(id, hex()), txids.get(id)!);
    const P = w.phone;

    // Old history (pushed long ago): the six proof requests' transactions, the two labels, tx 318 and its 3 outputs.
    const reqs: [number, number, number][] = [
      [1, 2, 430],
      [2, 3, 1326],
      [5, 7, 464],
      [6, 8, 463],
      [7, 9, 2485],
      [8, 10, 664],
    ];
    for (const [, txId] of reqs)
      await P.insertTransaction(txRow(w.pu, txId, txidOf(txId), tOld, { status: 'completed' }) as never);
    for (const [reqId, txId, raw] of reqs)
      await P.insertProvenTxReq({
        created_at: tOld,
        updated_at: tOld,
        provenTxReqId: reqId,
        txid: txidOf(txId),
        status: 'completed',
        attempts: 1,
        notified: true,
        history: '{}',
        notify: JSON.stringify({ transactionIds: [txId] }),
        rawTx: bytes(raw),
      } as never);
    for (const [id, label] of [
      [33, 'admin originator yours-mobile'],
      [60, 'admin month 2026-11'],
    ] as const)
      await P.insertTxLabel({
        created_at: tOld,
        updated_at: tOld,
        txLabelId: id,
        userId: w.pu,
        label,
        isDeleted: false,
      } as never);
    await P.insertTransaction(txRow(w.pu, 318, txidOf(318), tOld, { status: 'completed' }) as never);
    for (const [id, vout] of [
      [1439, 5],
      [1440, 0],
      [1441, 3],
    ])
      await P.insertOutput(
        outRow(w.pu, id, 318, txidOf(318), vout, tOld, { basketId: undefined, change: false, type: 'custom' }) as never,
      );

    // The phone's own payments up to 6 Nov 02:03 (pushed): 392, 394, 395, 399, 400 and their coins.
    // Their newest row (399, proven later) set the pass's cursor; the rest are a little older.
    const tEarlier = new Date(tOwn.getTime() - 600_000);
    for (const id of [392, 394, 395, 399, 400])
      await P.insertTransaction(txRow(w.pu, id, txidOf(id), id === 399 ? tOwn : tEarlier) as never);
    for (const [id, tx, vout] of [
      [1632, 392, 1],
      [1637, 394, 1],
      [1639, 395, 1],
      [1646, 399, 0],
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((v) => [1647 + v, 400, v]),
    ])
      await P.insertOutput(outRow(w.pu, id, tx, txidOf(tx), vout, tEarlier, { spendable: true }) as never);
    await w.push();

    // The extension's transactions, on the backup and taken in by the phone with their own (older) times.
    const ext: [number, [number, number][]][] = [
      [
        416,
        [
          [1699, 2],
          [1700, 3],
          [1701, 4],
          [1702, 5],
          [1703, 6],
          [1705, 8],
          [1706, 9],
        ],
      ],
      [417, [[1708, 1]]],
      [418, [[1710, 1]]],
      [419, [[1712, 1]]],
      [420, [[1714, 1]]],
      [421, [[1716, 0]]],
      [
        422,
        [
          [1720, 3],
          [1721, 4],
          [1724, 7],
          [1725, 8],
          [1726, 9],
        ],
      ],
      [
        423,
        [
          [1728, 7],
          [1729, 5],
          [1730, 1],
          [1731, 3],
          [1732, 2],
          [1733, 0],
          [1734, 6],
        ],
      ],
      [
        424,
        [
          [1737, 2],
          [1738, 3],
          [1739, 4],
          [1740, 5],
          [1741, 6],
          [1742, 7],
          [1743, 8],
          [1744, 9],
        ],
      ],
      [
        425,
        [
          [1747, 2],
          [1748, 3],
        ],
      ],
      [427, [[1750, 0]]],
      [429, [[1752, 0]]],
    ];
    let serverOut = 257_000;
    for (const [id, outs] of ext) {
      const serverId = 36_000 + id;
      await w.server.insertTransaction(txRow(w.su, serverId, txidOf(id), tExt) as never);
      await P.insertTransaction(txRow(w.pu, id, txidOf(id), tExt) as never);
      for (const [oid, vout] of outs) {
        await w.server.insertOutput(outRow(w.su, ++serverOut, serverId, txidOf(id), vout, tExt) as never);
        await P.insertOutput(outRow(w.pu, oid, id, txidOf(id), vout, tExt) as never);
      }
    }

    // 6-7 Nov on the phone: proofs, two seals with their labels and coins, re-stamped requests, admissions.
    const at = () => new Date();
    await P.updateUser(w.pu, { updated_at: at() } as never);
    for (const [pid, tx] of [
      [364, 399],
      [365, 400],
      [366, 430],
    ])
      await P.insertProvenTx({
        created_at: at(),
        updated_at: at(),
        provenTxId: pid,
        txid: txidOf(tx),
        height: 974_243,
        index: 0,
        merklePath: bytes(40),
        rawTx: bytes(300),
        blockHash: hex(),
        merkleRoot: hex(),
      } as never);
    await P.updateTransaction(399, { status: 'completed', provenTxId: 364 } as never);
    await P.updateTransaction(400, { status: 'completed', provenTxId: 365 } as never);
    await P.insertTransaction(txRow(w.pu, 430, txidOf(430), at(), { status: 'completed', provenTxId: 366 }) as never);
    await P.insertTransaction(txRow(w.pu, 431, txidOf(431), at()) as never);
    await P.updateOutput(1651, { spendable: false, spentBy: 430 } as never);
    await P.insertOutput(
      outRow(w.pu, 1753, 430, txidOf(430), 0, at(), {
        basketId: undefined,
        change: false,
        type: 'custom',
        satoshis: 0,
      }) as never,
    );
    await P.insertOutput(outRow(w.pu, 1754, 430, txidOf(430), 1, at(), { spentBy: 431 }) as never);
    await P.insertOutput(
      outRow(w.pu, 1755, 431, txidOf(431), 0, at(), {
        basketId: undefined,
        change: false,
        type: 'custom',
        satoshis: 0,
      }) as never,
    );
    await P.insertOutput(outRow(w.pu, 1756, 431, txidOf(431), 1, at(), { spendable: true }) as never);
    for (const tx of [430, 431])
      for (const label of [60, 33])
        await P.insertTxLabelMap({
          created_at: at(),
          updated_at: at(),
          transactionId: tx,
          txLabelId: label,
          isDeleted: false,
        } as never);
    for (const [reqId] of reqs) await P.updateProvenTxReq(reqId, { history: '{"notes":[]}' } as never);
    for (const id of [1439, 1440, 1441, 1632, 1637, 1639]) await P.updateOutput(id, { spendable: false } as never);
    for (const [, outs] of ext) for (const [oid] of outs) await P.updateOutput(oid, { spendable: true } as never);

    const shape = (p: Page) =>
      Object.fromEntries(
        ['provenTxs', 'transactions', 'outputs', 'txLabelMaps', 'outputTagMaps', 'provenTxReqs'].map((k) => [
          k,
          p[k]?.length ?? 0,
        ]),
      );
    w.pages.length = 0;
    await expect(w.withoutCarrier(() => w.push())).rejects.toThrow(/transactionId/);
    expect(shape(w.pages[0])).toEqual({
      provenTxs: 3,
      transactions: 4,
      outputs: 47,
      txLabelMaps: 4,
      outputTagMaps: 0,
      provenTxReqs: 6,
    });
    expect(w.pages[0].provenTxReqs!.reduce((m, r) => Math.max(m, (r.rawTx as number[]).length), 0)).toBe(2485);

    w.pages.length = 0;
    await _resetPushPasses();
    await w.push();
    // The parents' share of a 64-row page is 16 and the coins' 16 parents use it up, so the label links (and what
    // follows them) go on the next page, with their labels.
    expect(shape(w.pages[0])).toEqual({
      provenTxs: 3,
      transactions: 20,
      outputs: 47,
      txLabelMaps: 0,
      outputTagMaps: 0,
      provenTxReqs: 0,
    });
    expect(shape(w.pages[1])).toMatchObject({ txLabelMaps: 4, provenTxReqs: 6 });
    expect(w.pages[1].txLabels!.map((l) => l.txLabelId).sort()).toEqual([33, 60]);
    const parents = w.pages[0].transactions!.filter((t) => ms(t.updated_at) === EPOCH).map((t) => t.transactionId);
    expect(parents.sort((a, b) => Number(a) - Number(b))).toEqual([
      318, 392, 394, 395, 416, 417, 418, 419, 420, 421, 422, 423, 424, 425, 427, 429,
    ]);
    for (const [id, outs] of ext)
      for (const [, vout] of outs) expect((await serverCoin(w, txidOf(id), vout)).spendable).toBe(true);
    expect((await serverCoin(w, txidOf(400), 4)).spendable).toBe(false);
    expect((await serverCoin(w, txidOf(431), 1)).spendable).toBe(true);
    expect(await w.server.findTxLabelMaps({ partial: {} })).toHaveLength(4);
  });
});

describe('addMissingParents on its own', () => {
  const store = (parent: Row = {}): ParentStore & { scans: number } => {
    const st = {
      scans: 0,
      getSettings: () => ({ storageIdentityKey: 'phone' }),
      findUsers: async () => [{ userId: 1 }],
      findTransactions: async (a: { partial: Record<string, unknown>; paged?: unknown }) => {
        if (a.paged || a.partial.transactionId === undefined) st.scans++; // only lookups by key are expected
        return [{ transactionId: 5, status: 'completed', updated_at: new Date(0), ...parent }];
      },
      findOutputs: async () => [],
      findTxLabels: async () => [],
      findOutputTags: async () => [],
      findProvenTxs: async () => [],
    };
    return st;
  };
  const page = () => ({
    transactions: [] as Row[],
    outputs: [{ outputId: 1, transactionId: 5, updated_at: new Date() }],
  });
  const args = { identityKey: 'id', since: new Date(1), offsets: [{ name: 'transaction', offset: 0 }], maxItems: 64 };

  test('a parent goes only to an entity the page shows the pass has read in full, found by its key alone', async () => {
    const s1 = store();
    const notRead = { outputs: page().outputs } as { transactions?: Row[]; outputs: Row[] };
    const r = await addMissingParents(s1, args, notRead);
    expect(notRead.transactions).toBeUndefined();
    expect(r.notExhausted).toEqual(['transactions']);
    const q = page();
    await addMissingParents(s1, args, q);
    expect(q.transactions.map((t) => t.transactionId)).toEqual([5]);
    expect(s1.scans).toBe(0);
  });

  test('a parent an earlier page of the pass carried is not sent again', async () => {
    const p = page();
    await addMissingParents(store(), args, p, { filed: new Map([['transactions', new Set([5])]]) });
    expect(p.transactions).toHaveLength(0);
  });

  test('a no-op parent goes in a state the backup leaves alone; otherwise its coin comes off the page', async () => {
    for (const parent of [
      { status: 'completed' },
      { status: 'unproven' },
      { status: 'sending' },
      { status: 'failed' },
      { status: 'nosend' },
    ]) {
      const p = page();
      const r = await addMissingParents(store(parent), args, p);
      expect([parent.status, p.transactions.length, p.outputs.length, r.held.length]).toEqual([parent.status, 1, 1, 0]);
    }
    for (const parent of [
      { status: 'unsigned' },
      { status: 'unprocessed' },
      { status: 'nonfinal' },
      { status: 'unfail' },
      { status: 'nosend', noSendExpiryMode: 'blocks' },
    ]) {
      const p = page();
      const r = await addMissingParents(store(parent), args, p);
      expect([parent.status, p.transactions.length, p.outputs.length]).toEqual([parent.status, 0, 0]);
      expect(r.held.map((h) => h.ref)).toEqual([{ key: 'outputs', outputId: 1 }]);
      expect(r.net).toEqual({ outputs: -1 }); // read, not sent: the offsets go on past it
    }
  });
});
