/**
 * The bounded full re-pull (CEO, 6 Nov 2026; services/fullPass.ts): once a day, after a failure, and on a store's first
 * open, this device pulls its backup again from the start, every row through the inbound check, in slices that never
 * hold up a payment, resuming from the toolbox's checkpoint.
 *
 * Real wallet-toolbox: StorageIdb stores on fake-indexeddb, a WalletStorageManager, the inbound guard as initWallet
 * installs it. The backup holds a synthetic wallet written straight into its tables (thousands of rows: transactions
 * with raw bytes, proofs and proof requests, four outputs each, most spent), read through a counting stand-in for the
 * StorageClient. No network.
 *
 * BWX_FULLPASS_BENCH=1 also measures a full pass at 1k / 5k / 20k outputs (rows, bytes, time).
 */
import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { KeyDeriver, P2PKH, PrivateKey, Random, Transaction, Utils } from '@bsv/sdk';
import { StorageIdb, StorageProvider, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import * as IS from '../services/inboundSync';
import { _setTailOffsetCap } from '../services/pullTail';
import {
  FULL_PASS_EVERY_MS,
  _setFullPassSlice,
  markOf,
  requestFullPass,
  syncStateFor,
  updateMark,
  withFullPassMode,
  _setPullOverlap,
  withDeadlines,
  asRestore,
  passUnderWay,
  requestTailPass,
  TAIL_CHECK_EVERY_MS,
  TAIL_RETRY_MS,
  STUCK_PASS_MS,
  abandonTail,
  rewind,
  type FullPassRequest,
  type SyncStateRow,
} from '../services/fullPass';

const T = 120_000;
const services = new Proxy(
  {
    chain: 'main',
    getChainTracker: async () => ({ isValidRootForHeight: async () => true, currentHeight: async () => 971_005 }),
    getHeight: async () => 971_005,
    nLockTimeIsFinal: async () => true,
    hashOutputScript: (s: string) => s,
  } as Record<string, unknown>,
  {
    get: (t, p) =>
      p in t || typeof p === 'symbol' || p === 'then'
        ? t[p as string]
        : async () => {
            throw new Error(`mock services: ${String(p)}`);
          },
  },
) as never;

let dbn = 0;
async function idb(name: string) {
  const s = new StorageIdb(StorageProvider.createStorageBaseOptions('main'));
  const db = `fullrepull-${name}-${++dbn}`; // its own names: fake-indexeddb is shared across files
  (s as unknown as { dbName: string }).dbName = db;
  await s.migrate(db, `sik-${db}`);
  await s.makeAvailable();
  s.setServices(services);
  return s;
}

const bytes = (n: number) => Array.from(Random(n));
/** The wallet's coins basket in the backup (a coin in no basket is never admitted). */
async function basketOf(b: StorageIdb, userId: number) {
  const had = (await b.findOutputBaskets({ partial: { userId, name: 'synthetic' } }))[0];
  if (had) return had.basketId;
  return b.insertOutputBasket({
    userId,
    name: 'synthetic',
    numberOfDesiredUTXOs: 0,
    minimumDesiredUTXOValue: 0,
    isDeleted: false,
  } as never);
}
const hex32 = () => Utils.toHex(Random(32));

/**
 * A synthetic wallet in the backup's tables: `outputs` outputs, four per transaction, each transaction mined (a proof and
 * a completed proof request, raw bytes and an input BEEF of `beefBytes`). Every `unspentEvery`th output is unspent and
 * spendable; the rest are spent by the next transaction. Returns the unspent outpoints.
 */
async function bigWallet(b: StorageIdb, identityKey: string, outputs: number, unspentEvery = 25, beefBytes = 1_500) {
  const { user } = await b.findOrInsertUser(identityKey);
  const basketId = await basketOf(b, user.userId);
  const txs = Math.ceil(outputs / 4);
  const ids: number[] = [];
  const raws: { txid: string; tx: Transaction }[] = [];
  for (let i = 0; i < txs; i++) {
    const tx = new Transaction();
    tx.addInput({
      sourceTXID: hex32(),
      sourceOutputIndex: 0,
      unlockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
      sequence: 0xffffffff,
    });
    for (let v = 0; v < 4; v++)
      tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 1_000 + v });
    const txid = tx.id('hex');
    const rawTx = tx.toBinary();
    const provenTxId = await b.insertProvenTx({
      txid,
      height: 900_000 + i,
      index: 0,
      merklePath: bytes(400),
      rawTx,
      blockHash: hex32(),
      merkleRoot: hex32(),
    } as never);
    await b.insertProvenTxReq({
      txid,
      status: 'completed',
      attempts: 1,
      notified: true,
      history: '{}',
      notify: '{}',
      rawTx,
      inputBEEF: bytes(beefBytes),
      provenTxId,
    } as never);
    ids.push(
      await b.insertTransaction({
        userId: user.userId,
        status: 'completed',
        reference: Utils.toBase64(Random(12)),
        isOutgoing: false,
        satoshis: 0,
        description: 'synthetic history',
        version: 1,
        lockTime: 0,
        txid,
        rawTx,
        inputBEEF: bytes(beefBytes),
        provenTxId,
      } as never),
    );
    raws.push({ txid, tx });
  }
  const unspent: string[] = [];
  let n = 0;
  for (let i = 0; i < txs; i++)
    for (let v = 0; v < 4 && n < outputs; v++, n++) {
      const free = n % unspentEvery === 0 || i === txs - 1;
      if (free) unspent.push(`${raws[i].txid}.${v}`);
      const script = raws[i].tx.outputs[v].lockingScript.toBinary();
      await b.insertOutput({
        userId: user.userId,
        transactionId: ids[i],
        vout: v,
        satoshis: 1_000 + v,
        spendable: free,
        change: false,
        type: 'custom',
        providedBy: 'you',
        purpose: '',
        outputDescription: 'synthetic',
        txid: raws[i].txid,
        lockingScript: script,
        scriptLength: script.length,
        basketId,
        ...(free ? {} : { spentBy: ids[i + 1] }),
      } as never);
    }
  return { unspent, txids: new Set(raws.map((r) => r.txid)) };
}

type Stats = { pages: number; items: number; jsonBytes: number; binBytes: number };
const ENTITIES = [
  'provenTxs',
  'outputBaskets',
  'outputTags',
  'txLabels',
  'transactions',
  'outputs',
  'txLabelMaps',
  'outputTagMaps',
  'certificates',
  'certificateFields',
  'commissions',
  'provenTxReqs',
] as const;
/** The size of a page as JSON (byte arrays as numbers) and as the binary wire (byte arrays raw). */
function sizeOf(chunk: Record<string, unknown>) {
  let bin = 0;
  const json = JSON.stringify(chunk, (_k, v: unknown) => {
    if (v instanceof Uint8Array || (Array.isArray(v) && v.length > 16 && v.every((x) => Number.isInteger(x)))) {
      const a = Array.from(v as ArrayLike<number>);
      bin += a.length;
      return a;
    }
    return v;
  }).length;
  const rest = JSON.stringify(chunk, (_k, v: unknown) =>
    v instanceof Uint8Array || (Array.isArray(v) && v.length > 16 && v.every((x) => Number.isInteger(x))) ? 0 : v,
  ).length;
  return { json, bin: bin + rest };
}

/** wallet.1sat.app as this device's StorageClient sees it: the backup's store, every page counted, failures on cue. */
function backupClient(b: StorageIdb) {
  const stats: Stats = { pages: 0, items: 0, jsonBytes: 0, binBytes: 0 };
  const o: { failAfterPages?: number } = {};
  const client = new Proxy(b, {
    get(t, p) {
      if (p === 'getSyncChunk')
        return async (args: unknown) => {
          if (o.failAfterPages !== undefined && stats.pages >= o.failAfterPages)
            throw new Error('network: the backup did not answer in time (getSyncChunk)'); // the heal's 120 s deadline
          const c = (await t.getSyncChunk(args as never)) as unknown as Record<string, unknown>;
          stats.pages++;
          for (const k of ENTITIES) stats.items += (c[k] as unknown[] | undefined)?.length ?? 0;
          const s = sizeOf(c);
          stats.jsonBytes += s.json;
          stats.binBytes += s.bin;
          return c;
        };
      const v = Reflect.get(t, p, t) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  return { client, stats, o };
}

/** This phone (its store active, the inbound check on) and its backup with a synthetic wallet of `outputs` outputs. */
async function phoneWith(outputs: number) {
  const root = PrivateKey.fromRandom();
  const kd = new KeyDeriver(root);
  const backup = await idb('backup');
  IS._mergeUnchecked(backup);
  const built = await bigWallet(backup, kd.identityKey, outputs);
  const phone = await idb('phone');
  const more = { n: 0 };
  const logs: string[] = [];
  const verifier: IS.InboundVerifier = {
    owns: IS.walletOwnership(root),
    readRecord: IS.walletRecords(root),
    spent: async () => ({ state: 'unspent' }) as never,
    txKnown: async (txid) => (built.txids.has(txid) ? 'known' : 'unknown'),
    onMore: () => void more.n++,
    log: (...a: unknown[]) => logs.push(a.map(String).join(' ')),
  };
  const off = IS.registerInboundVerifier(phone.getSettings().storageIdentityKey, kd.identityKey, verifier);
  // Checked from the first merge on, as initWallet registers it before the factory opens the stores.
  const sm = new WalletStorageManager(kd.identityKey, phone, [backup]);
  await sm.makeAvailable();
  await sm.setActive(phone.getSettings().storageIdentityKey);
  sm.setServices(services);
  const { client, stats, o } = backupClient(backup);
  const sik = phone.getSettings().storageIdentityKey;
  const backupSik = backup.getSettings().storageIdentityKey;
  /** A device-sync pull, as initWallet runs it: the full pass asked for when due, then the merge in slices. */
  const pull = async (now?: number, failed = false, extra: Partial<FullPassRequest> = {}) => {
    const asked = await requestFullPass({
      manager: sm as never,
      store: phone as never,
      identityKey: kd.identityKey,
      readerSik: backupSik,
      now,
      failed,
      ...extra,
    });
    await withFullPassMode(sik, 'slice', () => sm.syncFromReader(kd.identityKey, client as never));
    return asked;
  };
  const state = async () => (await syncStateFor(phone as never, kd.identityKey, backupSik))!;
  /** Pull until the pass under way (from the start, deep or incremental) completes; the pulls (slices) it took. */
  const pullToEnd = async (max = 10_000) => {
    let pulls = 0;
    let st: SyncStateRow;
    do {
      await pull();
      pulls++;
      st = await state();
    } while ((st.when == null || passUnderWay(st)) && pulls < max);
    return pulls;
  };
  /** The admission list worked through (a run takes 25 entries): the number admitted. */
  const admit = async () => {
    let admitted = 0;
    for (let i = 0; i < 1_000; i++) {
      const r = await IS.admitPending(phone as never, kd.identityKey, verifier);
      admitted += r.admitted;
      if (!r.left || (!r.admitted && !r.refused)) break;
    }
    return { admitted };
  };
  const count = async () => ({
    outputs: (await phone.findOutputs({ partial: {} })).length,
    transactions: (await phone.findTransactions({ partial: {}, noRawTx: true })).length,
  });
  const spendable = async () =>
    (await phone.findOutputs({ partial: {} }))
      .filter((r) => r.spendable)
      .map((r) => `${r.txid}.${r.vout}`)
      .sort();
  return {
    kd,
    backup,
    phone,
    sm,
    sik,
    backupSik,
    built,
    stats,
    client,
    o,
    more,
    logs,
    verifier,
    off,
    pull,
    pullToEnd,
    state,
    admit,
    count,
    spendable,
  };
}

let uninstall = () => undefined as void;
beforeAll(() => {
  uninstall = IS.installInboundSyncGuard(StorageIdb);
});
afterEach(() => _setFullPassSlice());
afterAll(() => {
  uninstall();
  IS._resetInboundVerifiers();
});

const DAY = 24 * 3_600_000;

/** A transaction another copy pushed late (its time `age` ms ago) with one spendable coin, straight into the backup. */
async function latePush(b: StorageIdb, identityKey: string, age: number, sats: number) {
  const { user } = await b.findOrInsertUser(identityKey);
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: hex32(),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
    sequence: 0xffffffff,
  });
  tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: sats });
  const at = new Date(Date.now() - age);
  const transactionId = await b.insertTransaction({
    userId: user.userId,
    status: 'completed',
    reference: Utils.toBase64(Random(12)),
    isOutgoing: false,
    satoshis: 0,
    description: 'pushed late',
    version: 1,
    lockTime: 0,
    txid: tx.id('hex'),
    rawTx: tx.toBinary(),
    created_at: at,
    updated_at: at,
  } as never);
  const script = tx.outputs[0].lockingScript.toBinary();
  await b.insertOutput({
    userId: user.userId,
    transactionId,
    vout: 0,
    satoshis: sats,
    spendable: true,
    change: false,
    type: 'custom',
    providedBy: 'you',
    purpose: '',
    outputDescription: 'late',
    basketId: await basketOf(b, user.userId),
    txid: tx.id('hex'),
    lockingScript: script,
    scriptLength: script.length,
    created_at: at,
    updated_at: at,
  } as never);
  return tx.id('hex');
}

describe('the re-pull schedule (review 23 re-check)', () => {
  test(
    'a fresh install or restore pulls from the start at once; an install from before this release waits a random 0-72 h',
    async () => {
      const d = await phoneWith(400);
      try {
        // The store's first merge (here the open's, the backup naming itself active) is a pass from the start, and it
        // is recorded: nothing is due after it.
        expect(await d.count()).toEqual({ outputs: 400, transactions: 100 });
        expect(typeof markOf(await d.state()).doneAt).toBe('number');
        expect(await d.pull()).toBe('not-due');
        // An install that synced before this release: no record yet. Its first full pass waits (here 36 h).
        await updateMark(d.phone as never, await d.state(), { doneAt: undefined, firstAt: undefined });
        const t0 = Date.now();
        expect(await d.pull(t0, false, { random: () => 0.5 })).toBe('not-due');
        expect(markOf(await d.state()).firstAt).toBe(t0 + 36 * 3_600_000);
        expect(await d.pull(t0 + 35 * 3_600_000)).toBe('deep'); // the daily deep pull still runs meanwhile
        await d.pullToEnd();
        expect(await d.pull(t0 + 37 * 3_600_000)).toBe('started');
        await d.pullToEnd();
        expect(typeof markOf(await d.state()).doneAt).toBe('number');
      } finally {
        d.off();
      }
    },
    T,
  );

  test(
    'daily: a deep pull from 48 h back brings a row pushed hours late; weekly: the full pass brings one days late',
    async () => {
      const d = await phoneWith(200);
      try {
        await d.pullToEnd();
        const hours = await latePush(d.backup, d.kd.identityKey, 3 * 3_600_000, 11_111);
        const days = await latePush(d.backup, d.kd.identityKey, 3 * DAY, 22_222);
        d.built.txids.add(hours);
        d.built.txids.add(days);
        const t0 = Date.now();
        expect(await d.pull(t0 + 3_600_000)).toBe('not-due');
        await d.pullToEnd();
        const has = async (txid: string) => (await d.phone.findOutputs({ partial: { txid } })).length;
        expect([await has(hours), await has(days)]).toEqual([0, 0]); // past the 15-min overlap
        expect(await d.pull(t0 + DAY + 1)).toBe('deep');
        await d.pullToEnd();
        expect([await has(hours), await has(days)]).toEqual([1, 0]);
        expect(await d.pull(t0 + DAY + 2)).toBe('not-due'); // once a day
        expect(await d.pull(t0 + 8 * DAY)).toBe('started');
        await d.pullToEnd();
        expect([await has(hours), await has(days)]).toEqual([1, 1]);
        await d.admit();
        const spendable = await d.spendable();
        expect(spendable).toContain(`${hours}.0`);
        expect(spendable).toContain(`${days}.0`);
      } finally {
        d.off();
      }
    },
    T,
  );

  test(
    'weekly on a phone: only on Wi-Fi; off Wi-Fi for 14 days, once on mobile data with a one-line notice of its size',
    async () => {
      const d = await phoneWith(400);
      try {
        await d.pullToEnd();
        const done = markOf(await d.state()).doneAt!;
        const notices: number[] = [];
        const phone = (wifi: boolean | undefined) => ({
          phone: true,
          wifi: async () => wifi,
          onMobileData: (mb: number) => void notices.push(mb),
        });
        /** The pass completes on the test's clock (the guard stamps real time). */
        const finish = async (at: number) => {
          await d.pullToEnd();
          await updateMark(d.phone as never, await d.state(), { doneAt: at, deepDoneAt: at });
        };
        // A week on: on mobile data, no full pass (the deep pull instead); on Wi-Fi, the full pass.
        expect(await d.pull(done + 8 * DAY, false, phone(false))).toBe('deep');
        await finish(done); // the deep pull only; the last full pass stays a week old
        expect(await d.pull(done + 8 * DAY + 1, false, phone(true))).toBe('started');
        await finish(done + 8 * DAY + 1);
        expect(notices).toEqual([]);
        // Then off Wi-Fi: 13 days on, still nothing on mobile data; 14 days on, once, with the notice.
        const wifiAt = markOf(await d.state()).wifiAt!;
        expect(wifiAt).toBe(done + 8 * DAY + 1);
        expect(await d.pull(wifiAt + 13 * DAY, false, phone(false))).toBe('deep');
        await finish(done + 8 * DAY + 1);
        expect(notices).toEqual([]);
        expect(await d.pull(wifiAt + 14 * DAY, false, phone(false))).toBe('started');
        expect(notices.length).toBe(1);
        expect(notices[0]).toBeGreaterThanOrEqual(1);
        await finish(wifiAt + 14 * DAY);
        // Not again a week later while still off Wi-Fi: 14 days from that pass.
        expect(await d.pull(wifiAt + 21 * DAY + 1, false, phone(false))).toBe('deep');
        expect(notices.length).toBe(1);
        // A network the phone can't tell counts as not Wi-Fi; the web wallet and the extension: any network.
        await finish(wifiAt + 14 * DAY);
        expect(await d.pull(wifiAt + 22 * DAY, false, { phone: false, wifi: async () => undefined })).toBe('started');
      } finally {
        d.off();
      }
    },
    T,
  );

  test(
    'on demand, rate-limited (N1): one full pass per 24 h from errors; retries resume and never start a new one',
    async () => {
      const d = await phoneWith(200);
      try {
        await d.pullToEnd();
        const t0 = Date.now();
        expect(await d.pull(t0, true)).toBe('started'); // a failed heal: a full pass
        await d.pullToEnd();
        expect(await d.pull(t0 + 3_600_000, true)).not.toBe('started'); // another failed heal within 24 h
        await d.pullToEnd();
        // A row the backup never sends the transaction of (an orphan): every retry resumes the stuck pass, a few pages.
        const { user } = await d.backup.findOrInsertUser(d.kd.identityKey);
        await d.backup.insertOutput({
          userId: user.userId,
          transactionId: 987_654,
          vout: 0,
          satoshis: 5_000,
          spendable: false,
          change: false,
          type: 'custom',
          providedBy: 'you',
          purpose: '',
          outputDescription: 'orphan',
          txid: hex32(),
          lockingScript: [0x51],
          scriptLength: 1,
        } as never);
        const plans: string[] = [];
        const pages: number[] = [];
        for (let i = 0; i < 6; i++) {
          const p0 = d.stats.pages;
          const r = await d.pull(t0 + 2 * 3_600_000 + i * 60_000, i % 2 === 1).then(
            (x) => x,
            (e: unknown) => String(e),
          );
          plans.push(r);
          pages.push(d.stats.pages - p0);
        }
        expect(plans.some((p) => p === 'started')).toBe(false);
        expect(Math.max(...pages.slice(1))).toBeLessThanOrEqual(5); // the pages up to the stuck one, never the whole pass
        expect(markOf(await d.state()).due).toBe('unfiled');
        // A day after the last error-driven pass: one more pass from the start; it meets the orphan, and the next day's
        // limit starts again from there.
        expect(await d.pull(t0 + DAY + 1).catch((e: unknown) => String(e))).toContain(IS.UNFILED_PAGE);
        expect(typeof markOf(await d.state()).onDemandAt).toBe('number');
        // (The guard stamps real time; here that pass ran on the test's clock.)
        await updateMark(d.phone as never, await d.state(), { onDemandAt: t0 + DAY + 1 });
        for (let i = 0; i < 3; i++)
          expect(
            await requestFullPass({
              manager: d.sm as never,
              store: d.phone as never,
              identityKey: d.kd.identityKey,
              readerSik: d.backupSik,
              now: t0 + DAY + 2 + i * 3_600_000,
              failed: true,
            }),
          ).toBe('resuming');
      } finally {
        d.off();
      }
    },
    T,
  );

  test(
    "a merge with no mode (the wallet factory's at open) leaves a pass we started to the pulls (N2); a restore runs it",
    async () => {
      const d = await phoneWith(400);
      try {
        await d.pullToEnd();
        expect(
          await requestFullPass({
            manager: d.sm as never,
            store: d.phone as never,
            identityKey: d.kd.identityKey,
            readerSik: d.backupSik,
            now: Date.now() + 8 * DAY,
          }),
        ).toBe('started');
        const more = d.more.n;
        const t = Date.now();
        await d.sm.syncFromReader(d.kd.identityKey, d.backup as never); // no mode: as createWalletCore's setActive
        expect(Date.now() - t).toBeLessThan(2_000);
        expect(d.more.n).toBe(more + 1);
        const st = await d.state();
        expect([st.when, passUnderWay(st)]).toEqual([undefined, false]); // nothing merged, nothing moved
        // An explicit restore runs the pass whole, as before.
        await asRestore(() => d.sm.syncFromReader(d.kd.identityKey, d.backup as never));
        const after = await d.state();
        expect(after.when).toBeDefined();
        expect(typeof markOf(after).doneAt).toBe('number');
      } finally {
        d.off();
      }
    },
    T,
  );

  test(
    'a pass from the start asks the chain again about coins whose admission was given up (N3)',
    async () => {
      const d = await phoneWith(400);
      try {
        await d.pullToEnd();
        const list = IS.admissionListFor(d.sik);
        const queued = await list.list(d.kd.identityKey);
        expect(queued.length).toBe(d.built.unspent.length);
        for (const e of queued) await list.remove(e.key); // given up after 3 days
        expect(await d.spendable()).toEqual([]);
        expect(await d.pull(Date.now() + 8 * DAY)).toBe('started');
        await d.pullToEnd();
        expect((await list.list(d.kd.identityKey)).length).toBe(d.built.unspent.length);
        await d.admit();
        expect(await d.spendable()).toEqual([...d.built.unspent].sort());
        // Admitted coins are not queued again by the next full pass (no double admission).
        expect(await d.pull(Date.now() + 16 * DAY)).toBe('started');
        await d.pullToEnd();
        expect(await list.list(d.kd.identityKey)).toEqual([]);
      } finally {
        d.off();
      }
    },
    T,
  );
});

describe('the full re-pull: how it runs', () => {
  test(
    'in slices: no pull holds the storage locks past its slice, a payment gets in between, every row arrives once',
    async () => {
      const d = await phoneWith(2_000);
      try {
        await d.pullToEnd();
        expect(await d.admit()).toMatchObject({ admitted: d.built.unspent.length });
        const spendable = await d.spendable();
        expect(spendable).toEqual([...d.built.unspent].sort());
        _setFullPassSlice(150);
        expect(await d.pull(Date.now() + FULL_PASS_EVERY_MS + 1)).toBe('started');
        let pulls = 1;
        let longest = 0;
        const between: number[] = [];
        while ((await d.state()).when == null) {
          // A payment's storage call between two slices: it waits for no pass.
          const t0 = Date.now();
          await d.sm.runAsStorageProvider(async () => 'paid');
          between.push(Date.now() - t0);
          const s = Date.now();
          await d.pull();
          longest = Math.max(longest, Date.now() - s);
          pulls++;
        }
        expect(pulls).toBeGreaterThan(2); // the pass took several slices
        expect(d.more.n).toBeGreaterThan(0); // and asked for each next one
        expect(Math.max(...between)).toBeLessThan(100);
        expect(longest).toBeLessThan(150 + 5_000); // a slice, plus at most the one page that ends it
        // No double admission: the re-pull queued nothing and admits nothing; the same coins, once each.
        expect(await IS.pendingAdmissions(d.phone as never, d.kd.identityKey)).toEqual([]);
        expect(await d.admit()).toMatchObject({ admitted: 0 });
        expect(await d.spendable()).toEqual(spendable);
        expect(await d.count()).toEqual({ outputs: 2_000, transactions: 500 });
      } finally {
        d.off();
      }
    },
    T,
  );

  test(
    'it resumes from its checkpoint across the heal deadline: no row fetched twice beyond one page, none missed',
    async () => {
      const d = await phoneWith(3_000);
      try {
        await d.pullToEnd();
        await d.admit();
        const spendable = await d.spendable();
        _setFullPassSlice(60_000); // one long pull, cut by the deadline
        await updateMark(d.phone as never, await d.state(), { doneAt: 0 });
        const pages0 = d.stats.pages;
        const items0 = d.stats.items;
        d.o.failAfterPages = pages0 + 3; // the 120 s deadline lands after three pages
        expect(await d.pull().catch((e: unknown) => String(e))).toContain('did not answer in time');
        const cut = await d.state();
        expect(cut.when).toBeUndefined(); // still a pass from the start, with its offsets kept
        const offsets = JSON.parse(String(cut.syncMap)) as Record<string, { count?: number }>;
        expect(Object.values(offsets).some((m) => (m.count ?? 0) > 0)).toBe(true);
        // The next heal after the failure doesn't start over: it resumes.
        expect(
          await requestFullPass({
            manager: d.sm as never,
            store: d.phone as never,
            identityKey: d.kd.identityKey,
            readerSik: d.backupSik,
            failed: true,
          }),
        ).toBe('resuming');
        d.o.failAfterPages = undefined;
        await d.pullToEnd();
        const total = 3_000 + 750 * 3; // outputs + transactions, proofs and proof requests
        const fetched = d.stats.items - items0;
        expect(fetched).toBeGreaterThanOrEqual(total);
        expect(fetched).toBeLessThan(total + 1_000); // at most the page the deadline cut, again
        expect(await d.count()).toEqual({ outputs: 3_000, transactions: 750 });
        expect(await IS.pendingAdmissions(d.phone as never, d.kd.identityKey)).toEqual([]);
        expect(await d.spendable()).toEqual(spendable);
      } finally {
        d.off();
      }
    },
    T,
  );
});

describe('review 23, M2: a device-sync pull never holds the storage locks on a stalled backup', () => {
  test(
    'a backup that stops answering fails the pull at its deadline; the locks are free at once after',
    async () => {
      const d = await phoneWith(100);
      try {
        await d.pullToEnd();
        let release: () => void = () => undefined;
        const stalled = new Proxy(d.backup, {
          get(t, p) {
            if (p === 'getSyncChunk') return () => new Promise((r) => (release = () => r(undefined)));
            const v = Reflect.get(t, p, t) as unknown;
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
          },
        });
        const t0 = Date.now();
        const e = await d.sm.syncFromReader(d.kd.identityKey, withDeadlines(stalled, 200, 400) as never).then(
          () => undefined,
          (x: unknown) => String(x),
        );
        expect(e).toContain('did not answer in time (getSyncChunk)');
        expect(Date.now() - t0).toBeLessThan(2_000);
        const t1 = Date.now();
        expect(await d.sm.runAsStorageProvider(async () => 'paid')).toBe('paid');
        expect(Date.now() - t1).toBeLessThan(100);
        release();
      } finally {
        d.off();
      }
    },
    T,
  );
});

describe('review 23: the push re-sends parents within limits, only to a backup; a rewind hits the right sync state', () => {
  /** The phone pushed once (a pass from the start), then touched one coin of every transaction it took in. */
  const touched = async (outputs: number) => {
    const d = await phoneWith(outputs);
    await d.pullToEnd();
    await d.sm.updateBackups();
    for (const o of await d.phone.findOutputs({ partial: { vout: 0 } }))
      await d.phone.updateOutput(o.outputId!, { outputDescription: 'touched' } as never);
    const backupTx = new Map(
      (await d.backup.findTransactions({ partial: {}, noRawTx: true })).map((t) => [
        t.txid,
        [t.status, +t.updated_at!],
      ]),
    );
    const args = async (extra: Record<string, unknown>) => ({
      ...(await d.backup.getSyncCheckpoint(
        { identityKey: d.kd.identityKey } as never,
        d.sik,
        d.phone.getSettings().storageName,
      )),
      identityKey: d.kd.identityKey,
      fromStorageIdentityKey: d.sik,
      toStorageIdentityKey: d.backupSik,
      maxItems: 1_000,
      maxRoughSize: 10_000_000,
      ...extra,
    });
    return { d, backupTx, args };
  };

  test(
    'L2: a push page carries at most a quarter of its items as parents, every output with its transaction, nothing after',
    async () => {
      const { d, backupTx, args } = await touched(400);
      try {
        const a = await args({ maxItems: 40, includeNextCheckpoint: true });
        expect(a.since).toBeDefined();
        const page = await d.phone.getSyncChunk(a as never);
        const txs = new Set((page.transactions ?? []).map((t) => t.transactionId));
        expect(page.transactions!.length).toBeLessThanOrEqual(10);
        expect(page.outputs!.length).toBeGreaterThan(0);
        expect(page.outputs!.every((o) => txs.has(o.transactionId))).toBe(true);
        for (const k of ['txLabelMaps', 'outputTagMaps', 'provenTxReqs'] as const)
          expect((page[k] as unknown[] | undefined)?.length ?? 0).toBe(0);
        // Parents only file: the epoch, no proof id.
        for (const t of page.transactions!) expect([+t.updated_at, t.provenTxId]).toEqual([0, undefined]);
        // The real push goes through, page after page, and changes no transaction on the backup.
        await d.sm.updateBackups();
        const outs = await d.backup.findOutputs({ partial: { vout: 0 } });
        expect(outs.every((o) => o.outputDescription === 'touched')).toBe(true);
        for (const t of await d.backup.findTransactions({ partial: {}, noRawTx: true }))
          expect([t.status, +t.updated_at!]).toEqual(backupTx.get(t.txid)!);
      } finally {
        d.off();
      }
    },
    T,
  );

  test(
    'L3: an export, a USB backup or a Repair Sync index (not a toolbox sync) reads the store with no rows added',
    async () => {
      const { d, args } = await touched(200);
      try {
        const page = await d.phone.getSyncChunk((await args({})) as never);
        expect(page.outputs!.length).toBeGreaterThan(0);
        expect(page.transactions ?? []).toEqual([]);
      } finally {
        d.off();
      }
    },
    T,
  );

  test(
    'L4: with a stray second sync state for the backup, the rewind is written to the one the toolbox reads',
    async () => {
      const d = await phoneWith(200);
      try {
        await d.pullToEnd();
        const real = await d.state();
        // A stray row for the same backup ahead of it ([0]), as a race could leave: the real one re-filed after it.
        const db = (d.phone as unknown as { db: { delete(s: string, k: number): Promise<void> } }).db;
        const { syncStateId: _id, ...copy } = real as Record<string, unknown>;
        await d.phone.insertSyncState({ ...copy, storageName: 'stray', refNum: 'stray', syncStateId: 0 } as never);
        await db.delete('sync_states', real.syncStateId!);
        await d.phone.insertSyncState({ ...copy, syncStateId: 0 } as never);
        const { user } = await d.phone.findOrInsertUser(d.kd.identityKey);
        const [stray] = await d.phone.findSyncStates({
          partial: { storageIdentityKey: d.backupSik, userId: user.userId },
        });
        expect(stray.storageName).toBe('stray'); // what [0] would pick
        // A gap the cursor skipped: a transaction pushed late with an old time, a coin under it touched since.
        _setPullOverlap(0);
        const { user: bu } = await d.backup.findOrInsertUser(d.kd.identityKey);
        const tx = new Transaction();
        tx.addInput({
          sourceTXID: hex32(),
          sourceOutputIndex: 0,
          unlockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
          sequence: 0xffffffff,
        });
        tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 5_000 });
        const old = new Date(Date.now() - 3_600_000);
        const transactionId = await d.backup.insertTransaction({
          userId: bu.userId,
          status: 'completed',
          reference: 'late-l4',
          isOutgoing: false,
          satoshis: 0,
          description: 'pushed late',
          version: 1,
          lockTime: 0,
          txid: tx.id('hex'),
          rawTx: tx.toBinary(),
          created_at: old,
          updated_at: old,
        } as never);
        const script = tx.outputs[0].lockingScript.toBinary();
        await d.backup.insertOutput({
          userId: bu.userId,
          transactionId,
          vout: 0,
          satoshis: 5_000,
          spendable: false,
          change: false,
          type: 'custom',
          providedBy: 'you',
          purpose: '',
          outputDescription: 'spent since',
          txid: tx.id('hex'),
          lockingScript: script,
          scriptLength: script.length,
        } as never);
        d.logs.length = 0;
        expect(await d.pullToEnd().then(() => 'ok')).toBe('ok');
        expect(d.logs.filter((l) => /earlier pull skipped/.test(l)).length).toBe(1);
        expect((await d.phone.findTransactions({ partial: { txid: tx.id('hex') } })).length).toBe(1);
        const after = (
          await d.phone.findSyncStates({ partial: { storageIdentityKey: d.backupSik, userId: user.userId } })
        )[0];
        expect([after.storageName, String(after.when), after.syncMap]).toEqual([
          'stray',
          String(stray.when),
          stray.syncMap,
        ]); // the stray row was never touched
      } finally {
        _setPullOverlap();
        d.off();
      }
    },
    T,
  );
});

describe.skipIf(process.env.BWX_FULLPASS_BENCH !== '1')('the full re-pull: cost (BWX_FULLPASS_BENCH=1)', () => {
  for (const n of (process.env.BWX_FULLPASS_SIZES ?? '1000,5000,20000').split(',').map(Number))
    test(
      `rows, bytes and time per full pass at ${n} outputs`,
      async () => {
        let t = Date.now();
        const d = await phoneWith(n);
        const setup = Date.now() - t;
        try {
          t = Date.now();
          const s0 = { ...d.stats };
          await d.pull();
          const first = { ms: Date.now() - t, ...diff(d.stats, s0) };
          await d.admit();
          const s1 = { ...d.stats };
          t = Date.now();
          expect(await d.pull(Date.now() + FULL_PASS_EVERY_MS + 1)).toBe('started');
          let slices = 1;
          while ((await d.state()).when == null) {
            await d.pull();
            slices++;
          }
          const again = { ms: Date.now() - t, ...diff(d.stats, s1), slices };
          console.log(
            `[full re-pull cost] ${n} outputs (setup ${setup} ms; the open's merge took the first pass) | an incremental pull with every row inside the 15-min overlap: ${first.items} rows, ${mb(first.binBytes)} binary, ${first.ms} ms | daily re-pull: ${again.items} rows, ${again.pages} pages, ${mb(again.binBytes)} binary / ${mb(again.jsonBytes)} JSON, ${again.ms} ms in ${again.slices} slices`,
          );
        } finally {
          d.off();
        }
      },
      3 * 3_600_000,
    );
});

const diff = (a: Stats, b: Stats): Stats => ({
  pages: a.pages - b.pages,
  items: a.items - b.items,
  jsonBytes: a.jsonBytes - b.jsonBytes,
  binBytes: a.binBytes - b.binBytes,
});
const mb = (n: number) => `${(n / 1_048_576).toFixed(2)} MB`;

describe('rows that land on the backup late with old times (extension, 6 Nov 2026: 8734977f, backup tx 38521)', () => {
  /** The tail check, as initWallet runs it before a device-sync pull. */
  const tail = (d: Awaited<ReturnType<typeof phoneWith>>, now: number) =>
    requestTailPass({
      manager: d.sm as never,
      store: d.phone as never,
      identityKey: d.kd.identityKey,
      readerSik: d.backupSik,
      reader: d.client as never,
      now,
    });
  const has = async (d: Awaited<ReturnType<typeof phoneWith>>, txid: string) =>
    (await d.phone.findOutputs({ partial: { txid } })).length;

  test(
    "the incremental pull skips them; the tail check finds them by the backup's insert order and pulls only from there",
    async () => {
      const d = await phoneWith(200);
      try {
        await d.pullToEnd();
        expect(await tail(d, Date.now())).toBe('in-step'); // nothing missing yet
        // The phone pushed 8734977f at 02:37 carrying 02:03 times: 34 minutes older than the cursor's 15-minute overlap.
        const late = await latePush(d.backup, d.kd.identityKey, 34 * 60_000, 3_500_000);
        d.built.txids.add(late);
        const t0 = Date.now();
        await d.pullToEnd();
        expect(await has(d, late)).toBe(0); // the bug: never sent
        const cursor = (await d.state()).when;
        expect(await tail(d, t0 + TAIL_CHECK_EVERY_MS + 1)).toBe('tail');
        const before = { ...d.stats };
        await d.pullToEnd();
        expect(await has(d, late)).toBe(1);
        // Only the rows after the first one this device never had: the late transaction, its coin, nothing else.
        expect(d.stats.items - before.items).toBeLessThanOrEqual(4);
        // The pass ends where the incremental cursor was (rows updated meanwhile before the tail still come), and it
        // is not recorded as a full pass (the weekly one stays due on its own schedule).
        const st = await d.state();
        expect(+new Date(st.when as string)).toBe(+new Date(cursor as string));
        expect(typeof markOf(st).tailDoneAt).toBe('number');
        expect(markOf(st).tailStartedAt).toBeUndefined();
        await d.admit();
        expect(await d.spendable()).toContain(`${late}.0`);
        // In step again: the next check (an interval on) finds nothing.
        expect(await tail(d, t0 + 2 * TAIL_CHECK_EVERY_MS + 2)).toBe('in-step');
      } finally {
        d.off();
      }
    },
    T,
  );

  test('a check when nothing is missing is a few one-row probes and starts nothing; not again within the interval', async () => {
    const d = await phoneWith(200);
    try {
      await d.pullToEnd();
      const st0 = await d.state();
      const before = { ...d.stats };
      const t0 = Date.now();
      expect(await tail(d, t0)).toBe('in-step');
      expect(d.stats.pages - before.pages).toBeLessThanOrEqual(24); // ≤ 2 probes per entity with ids
      expect(d.stats.items - before.items).toBeLessThanOrEqual(d.stats.pages - before.pages); // one row each at most
      const st = await d.state();
      expect(+new Date(st.when as string)).toBe(+new Date(st0.when as string)); // the cursor untouched
      expect(passUnderWay(st)).toBe(false);
      expect(await tail(d, t0 + TAIL_CHECK_EVERY_MS - 1)).toBe('not-due');
    } finally {
      d.off();
    }
  });

  test('never while a pass is under way (the pass reads everything anyway)', async () => {
    const d = await phoneWith(200);
    try {
      await d.pullToEnd();
      expect(await d.pull(Date.now() + 8 * DAY)).toBe('started'); // a weekly full pass begins
      _setFullPassSlice(0);
      await d.pull();
      expect(await tail(d, Date.now() + 9 * DAY)).toBe('busy');
    } finally {
      d.off();
    }
  });

  test('several late rows spread through history: one tail from the first, and each arrives', async () => {
    const d = await phoneWith(200);
    try {
      await d.pullToEnd();
      const a = await latePush(d.backup, d.kd.identityKey, 2 * DAY, 1_111);
      await d.pullToEnd(); // the cursor moves (an ordinary pull), a is still missing
      const b = await latePush(d.backup, d.kd.identityKey, 3 * DAY, 2_222);
      for (const t of [a, b]) d.built.txids.add(t);
      expect(await tail(d, Date.now() + TAIL_CHECK_EVERY_MS + 1)).toBe('tail');
      await d.pullToEnd();
      expect([await has(d, a), await has(d, b)]).toEqual([1, 1]);
    } finally {
      d.off();
    }
  });
});

describe('review of 8d59e33b: a stuck pass, an offset cap, an unfiled tail', () => {
  const tailCheck = (d: Awaited<ReturnType<typeof phoneWith>>, now: number, reader: unknown = d.client) =>
    requestTailPass({
      manager: d.sm as never,
      store: d.phone as never,
      identityKey: d.kd.identityKey,
      readerSik: d.backupSik,
      reader: reader as never,
      now,
    });
  const has = async (d: Awaited<ReturnType<typeof phoneWith>>, txid: string) =>
    (await d.phone.findOutputs({ partial: { txid } })).length;
  /** The schedule's answer alone (a pull's first step), whether or not the merge after it would fail. */
  const ask = (d: Awaited<ReturnType<typeof phoneWith>>, now: number) =>
    requestFullPass({
      manager: d.sm as never,
      store: d.phone as never,
      identityKey: d.kd.identityKey,
      readerSik: d.backupSik,
      now,
    });
  /** A pass from the start that gets a few pages in, then every page fails (the incident's shape). */
  const stuck = async (d: Awaited<ReturnType<typeof phoneWith>>, startedAt: number) => {
    await d.sm.runAsSync(async () => rewind(d.phone as never, await d.state(), startedAt, { onDemandAt: startedAt }));
    _setFullPassSlice(0);
    d.o.failAfterPages = d.stats.pages + 2;
    for (let i = 0; i < 3; i++) await d.pull(startedAt + i).catch(() => undefined);
    const st = await d.state();
    expect(st.when == null && passUnderWay(st)).toBe(true); // stopped part-way, the cursor unset
  };

  test(
    'the incident: a pass from the start stuck since yesterday is given up; the cursor comes back; the late coin arrives',
    async () => {
      const d = await phoneWith(200);
      try {
        await d.pullToEnd();
        const late = await latePush(d.backup, d.kd.identityKey, 34 * 60_000, 3_500_000);
        d.built.txids.add(late);
        const t0 = Date.now();
        await stuck(d, t0 - 30 * 3_600_000); // started "6 Nov 07:52", a day and more ago
        // The old build saved no cursor at the rewind: the last good one comes from the newest times the map has seen
        // for transactions and outputs (baskets, tags and labels rarely change: their times are months old).
        await updateMark(d.phone as never, await d.state(), { fromWhen: undefined });
        const sm = JSON.parse(String((await d.state()).syncMap)) as Record<string, { maxUpdated_at?: string }>;
        const expected = Math.min(+new Date(sm.transaction.maxUpdated_at!), +new Date(sm.output.maxUpdated_at!));
        await d.sm.runAsSync(async () => {
          // A basket last touched months ago (the incident: 27 Oct for baskets, 1 Nov for labels).
          const row = await d.state();
          const m = JSON.parse(String(row.syncMap)) as Record<string, { maxUpdated_at?: string }>;
          m.outputBasket.maxUpdated_at = new Date(t0 - 120 * DAY).toISOString();
          await d.phone.updateSyncState(row.syncStateId!, { syncMap: JSON.stringify(m) } as never);
        });
        // Not on wall-clock age: only when its offsets stop moving for STUCK_PASS_MS of uptime.
        expect(await ask(d, t0)).toBe('resuming');
        let plan = '';
        for (let m = 1; m <= 40 && plan !== 'abandoned'; m++) plan = await ask(d, t0 + m * 60_000);
        expect(plan).toBe('abandoned');
        d.o.failAfterPages = undefined;
        const st = await d.state();
        // The deep pull's 48 h before the newest transaction/output time: never the basket's months.
        expect(+new Date(st.when as string)).toBe(expected - 48 * 3_600_000);
        expect(st.when == null).toBe(false);
        expect(passUnderWay(st)).toBe(false);
        expect(markOf(st).startedAt).toBeUndefined();
        _setFullPassSlice();
        // No new full pass for a day; the pulls and the tail check run again.
        expect(await d.pull(t0 + 1)).not.toBe('started');
        await d.pullToEnd();
        if (!(await has(d, late))) {
          expect(await tailCheck(d, t0 + 2)).toBe('tail');
          await d.pullToEnd();
        }
        expect(await has(d, late)).toBe(1);
      } finally {
        d.off();
      }
    },
    T,
  );

  test('a long pass that keeps moving is never given up, even opened briefly once a day for a week', async () => {
    const d = await phoneWith(400);
    try {
      await d.pullToEnd();
      const t0 = Date.now();
      await d.sm.runAsSync(async () => rewind(d.phone as never, await d.state(), t0, { onDemandAt: t0 }));
      _setFullPassSlice(0); // one page a pull: the pass takes many opens
      for (let day = 0; day < 7; day++) {
        const at = t0 + day * DAY;
        expect(await ask(d, at)).not.toBe('abandoned');
        await d.pull(at);
      }
      expect(passUnderWay(await d.state()) || markOf(await d.state()).doneAt !== undefined).toBe(true);
      expect(markOf(await d.state()).abandonedAt).toBeUndefined();
    } finally {
      _setFullPassSlice();
      d.off();
    }
  });

  test('a stuck pass on a phone opened briefly each day is still given up (each open counts up to 5 minutes)', async () => {
    const d = await phoneWith(200);
    try {
      await d.pullToEnd();
      const t0 = Date.now();
      await stuck(d, t0);
      let plan = '';
      let opens = 0;
      while (opens < 20 && plan !== 'abandoned') plan = await ask(d, t0 + ++opens * DAY);
      expect(plan).toBe('abandoned');
      expect(opens).toBeLessThanOrEqual(STUCK_PASS_MS / (5 * 60_000) + 1);
    } finally {
      d.o.failAfterPages = undefined;
      d.off();
    }
  });

  test('a pass from the start that has not moved for 30 minutes of uptime is given up; a long gap counts 5 minutes', async () => {
    const d = await phoneWith(200);
    try {
      await d.pullToEnd();
      const t0 = Date.now();
      await stuck(d, t0);
      // Checks a minute apart while the wallet is open; one 2-hour gap (closed) in the middle counts for nothing.
      let t = t0 + 10;
      let plan = '';
      let minutes = 0;
      while (minutes < 40) {
        plan = await ask(d, t);
        await d.pull(t).catch(() => undefined); // the merge still fails (the pass's next page)
        if (plan === 'abandoned') break;
        t += minutes === 10 ? 2 * 3_600_000 : 60_000;
        minutes++;
      }
      expect(plan).toBe('abandoned');
      expect(minutes).toBeGreaterThanOrEqual(STUCK_PASS_MS / 60_000 - 6);
      expect(minutes).toBeLessThan(STUCK_PASS_MS / 60_000 + 3);
      // A cursor saved at the rewind is the one put back.
      expect((await d.state()).when == null).toBe(false);
    } finally {
      d.o.failAfterPages = undefined;
      d.off();
    }
  });

  test(
    'an older-build pass stopped mid-outputs, early coins touched recently: the fallback goes 48 h back and no output is skipped',
    async () => {
      const d = await phoneWith(400);
      try {
        await d.pullToEnd();
        const N = Date.now();
        const HOUR = 3_600_000;
        const outs = (await d.backup.findOutputs({ partial: {} })).sort((a, b) => a.outputId - b.outputId);
        const txs = (await d.backup.findTransactions({ partial: {}, noRawTx: true })).sort(
          (a, b) => a.transactionId - b.transactionId,
        );
        const lateX = outs[outs.length - 3];
        // Another device changed coin X (late in the backup's order) an hour after this device's cursor.
        await d.backup.updateOutput(lateX.outputId, { spendable: false, updated_at: new Date(N + HOUR) } as never);
        // Early rows touched recently: the stuck pass reads them, so the newest times it saw are 5 h on.
        await d.backup.updateOutput(outs[1].outputId, { updated_at: new Date(N + 5 * HOUR) } as never);
        await d.backup.updateTransaction(txs[0].transactionId, { updated_at: new Date(N + 5 * HOUR) } as never);
        // A pass from the start on the old build (no saved cursor) reads every transaction and the first outputs.
        await d.sm.runAsSync(async () => rewind(d.phone as never, await d.state(), N, { onDemandAt: N }));
        await updateMark(d.phone as never, await d.state(), { fromWhen: undefined });
        _setFullPassSlice(0);
        const outputCount = async () =>
          (JSON.parse(String((await d.state()).syncMap)) as Record<string, { count: number }>).output.count;
        for (let i = 0; i < 50 && (await outputCount()) === 0; i++) await d.pull(N);
        expect(await outputCount()).toBeGreaterThan(0);
        expect(await outputCount()).toBeLessThan(outs.length - 3); // X not reached
        d.o.failAfterPages = d.stats.pages; // then it stalls
        let plan = '';
        for (let m = 1; m <= 40 && plan !== 'abandoned'; m++) plan = await ask(d, N + m * 60_000);
        expect(plan).toBe('abandoned');
        expect(+new Date((await d.state()).when as string)).toBeLessThanOrEqual(N + 5 * HOUR - 48 * HOUR);
        d.o.failAfterPages = undefined;
        _setFullPassSlice();
        await d.pullToEnd();
        const x = (await d.phone.findOutputs({ partial: { txid: lateX.txid, vout: lateX.vout } }))[0];
        expect(+x.updated_at!).toBeGreaterThanOrEqual(N + HOUR); // X's change arrived
      } finally {
        d.o.failAfterPages = undefined;
        _setFullPassSlice();
        d.off();
      }
    },
    T,
  );

  test('an entity too large to skip: the earlier ones still get their tail, and the pass ends where it begins', async () => {
    const d = await phoneWith(400);
    try {
      await d.pullToEnd();
      const late = await latePush(d.backup, d.kd.identityKey, 34 * 60_000, 4_321);
      d.built.txids.add(late);
      _setTailOffsetCap(200); // proofs and transactions (~100) fit; outputs (401) count as oversized here
      expect(await tailCheck(d, Date.now())).toBe('tail');
      await d.pullToEnd();
      expect((await d.phone.findTransactions({ partial: { txid: late }, noRawTx: true })).length).toBe(1);
      const st = await d.state();
      expect(passUnderWay(st)).toBe(false); // ended cleanly at the outputs, offsets reset
      expect(st.when == null).toBe(false);
      expect(markOf(st).tailStartedAt).toBeUndefined();
    } finally {
      _setTailOffsetCap();
      d.off();
    }
  });

  test('a backup that refuses the probes (an offset cap): tried again after TAIL_RETRY_MS, never before every pull', async () => {
    const d = await phoneWith(200);
    try {
      await d.pullToEnd();
      const capped = new Proxy(d.client, {
        get: (t, p) =>
          p === 'getSyncChunk'
            ? async (a: { offsets: { offset: number }[] }) => {
                if (a.offsets.some((o) => o.offset > 3)) throw new Error('offset exceeds the cap');
                return (t as unknown as { getSyncChunk: (x: unknown) => Promise<unknown> }).getSyncChunk(a);
              }
            : Reflect.get(t, p, t),
      });
      const t0 = Date.now();
      expect(await tailCheck(d, t0, capped)).toBe('unknown');
      expect(await tailCheck(d, t0 + 60_000, capped)).toBe('not-due');
      expect(await tailCheck(d, t0 + TAIL_RETRY_MS + 1, d.client)).toBe('in-step');
    } finally {
      d.off();
    }
  });

  test('a tail pass given up (an unfiled row): the cursor back, offsets reset, a full pass asked for', async () => {
    const d = await phoneWith(200);
    try {
      await d.pullToEnd();
      const late = await latePush(d.backup, d.kd.identityKey, 34 * 60_000, 1_234);
      d.built.txids.add(late);
      const cursor = (await d.state()).when;
      expect(await tailCheck(d, Date.now())).toBe('tail');
      expect(passUnderWay(await d.state())).toBe(true);
      await d.sm.runAsSync(async () => abandonTail(d.phone as never, await d.state(), { due: 'unfiled' }));
      const st = await d.state();
      expect(+new Date(st.when as string)).toBe(+new Date(cursor as string));
      expect(passUnderWay(st)).toBe(false);
      expect(markOf(st).due).toBe('unfiled');
      expect(markOf(st).tailStartedAt).toBeUndefined();
      expect(await d.pull(Date.now() + 1)).toBe('started'); // the full pass it asked for
    } finally {
      d.off();
    }
  });
});
