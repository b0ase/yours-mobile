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
  const pull = async (now?: number, failed = false) => {
    const asked = await requestFullPass({
      manager: sm as never,
      store: phone as never,
      identityKey: kd.identityKey,
      readerSik: backupSik,
      now,
      failed,
    });
    await withFullPassMode(sik, 'slice', () => sm.syncFromReader(kd.identityKey, client as never));
    return asked;
  };
  const state = async () => (await syncStateFor(phone as never, kd.identityKey, backupSik))!;
  /** Pull until the pass from the start completes; the number of pulls (slices) it took. */
  const pullToEnd = async (max = 10_000) => {
    let pulls = 0;
    do {
      await pull();
      pulls++;
    } while ((await state()).when == null && pulls < max);
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

describe('the full re-pull: when it runs', () => {
  test(
    '(c) a fresh store: its first pull is the pass from the start and is recorded; a store with no record starts one',
    async () => {
      const d = await phoneWith(400);
      try {
        // The store's first merge (here the open's, the backup naming itself active) is a pass from the start, and it
        // is recorded: the first pull after it has nothing due.
        expect(await d.count()).toEqual({ outputs: 400, transactions: 100 });
        const done = markOf(await d.state()).doneAt;
        expect(typeof done).toBe('number');
        expect(await d.pull()).toBe('not-due');
        // The first open on this release (or a restore into a store that has synced before): no record yet.
        await updateMark(d.phone as never, await d.state(), { doneAt: undefined });
        expect(await d.pull()).toBe('started');
        expect(markOf(await d.state()).doneAt).toBeGreaterThanOrEqual(done!);
      } finally {
        d.off();
      }
    },
    T,
  );

  test(
    '(a) once a day: not again within 24 h, again after; the pass from the start brings a row the cursor skipped',
    async () => {
      const d = await phoneWith(200);
      try {
        await d.pullToEnd();
        const at = Date.now();
        expect(await d.pull(at + 3_600_000)).toBe('not-due');
        // A row another copy pushed late, with an older time: no incremental pull sends it.
        const { user } = await d.backup.findOrInsertUser(d.kd.identityKey);
        const tx = new Transaction();
        tx.addInput({
          sourceTXID: hex32(),
          sourceOutputIndex: 0,
          unlockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
          sequence: 0xffffffff,
        });
        tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 7_777 });
        const old = new Date(Date.now() - 3_600_000);
        const transactionId = await d.backup.insertTransaction({
          userId: user.userId,
          status: 'completed',
          reference: 'late',
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
          userId: user.userId,
          transactionId,
          vout: 0,
          satoshis: 7_777,
          spendable: true,
          change: false,
          type: 'custom',
          providedBy: 'you',
          purpose: '',
          outputDescription: 'late',
          basketId: await basketOf(d.backup, user.userId),
          txid: tx.id('hex'),
          lockingScript: script,
          scriptLength: script.length,
          created_at: old,
          updated_at: old,
        } as never);
        await d.pull(at + 3_600_000);
        expect((await d.phone.findOutputs({ partial: { txid: tx.id('hex') } })).length).toBe(0);
        expect(await d.pull(at + FULL_PASS_EVERY_MS + 1)).toBe('started');
        await d.pullToEnd();
        const [row] = await d.phone.findOutputs({ partial: { txid: tx.id('hex') } });
        expect(row?.spendable).toBe(false); // arrived, held for the chain like any backup coin
        d.built.txids.add(tx.id('hex'));
        await d.admit();
        expect(await d.spendable()).toContain(`${tx.id('hex')}.0`);
      } finally {
        d.off();
      }
    },
    T,
  );

  test(
    "(b) a failed heal merge asks for one at the next heal; a page it can't file asks to start again; a heal leaves it to the pulls",
    async () => {
      const d = await phoneWith(200);
      try {
        await d.pullToEnd();
        expect(await d.pull()).toBe('not-due');
        // The next heal after a failed one: a full pass, though the last is minutes old.
        expect(
          await requestFullPass({
            manager: d.sm as never,
            store: d.phone as never,
            identityKey: d.kd.identityKey,
            readerSik: d.backupSik,
            failed: true,
          }),
        ).toBe('started');
        // The heal itself (its merge in 'defer' mode, as initWallet runs setActive) merges none of it and is quick:
        // the device-sync pulls are asked to carry it.
        const before = d.stats.pages;
        await withFullPassMode(d.sik, 'defer', () => d.sm.syncFromReader(d.kd.identityKey, d.backup as never));
        expect(d.more.n).toBeGreaterThan(0);
        expect((await d.state()).when).toBeUndefined();
        expect(d.stats.pages).toBe(before);
        await d.pullToEnd();
        expect(typeof markOf(await d.state()).doneAt).toBe('number');

        // A row filed under a transaction the backup doesn't have, met in a pass from the start: UNFILED_PAGE, and the
        // next request starts the pass again even though one is under way.
        const { user } = await d.backup.findOrInsertUser(d.kd.identityKey);
        await d.backup.insertOutput({
          userId: user.userId,
          transactionId: 99_999,
          vout: 0,
          satoshis: 1,
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
        let e: unknown;
        try {
          await d.pull(Date.now() + FULL_PASS_EVERY_MS + 1); // the daily pass
          await d.pullToEnd(50);
        } catch (x) {
          e = x;
        }
        expect(String(e)).toContain(IS.UNFILED_PAGE);
        expect(markOf(await d.state()).due).toBe('unfiled');
        expect(
          await requestFullPass({
            manager: d.sm as never,
            store: d.phone as never,
            identityKey: d.kd.identityKey,
            readerSik: d.backupSik,
          }),
        ).toBe('started');
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
