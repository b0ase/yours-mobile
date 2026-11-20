/**
 * End to end (from the independent review, 20 Nov 2026): the spendable-first client code against the REAL spendable-first client code against the REAL bwalletx-storage server
 * (feat/spendable-first-server, createStorageServer on embedded Postgres, snapshot on), over real BRC-103 HTTP.
 * Old device = toolbox-client 2.14.5 StorageIdb + Wallet with received BRC-29 coins, backed up to the server the way a
 * device adds a backup (setActive workaround + addWalletStorageProvider + updateBackups). New device = fresh StorageIdb.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Beef, KeyDeriver, MerklePath, P2PKH, PrivateKey, ProtoWallet, Random, Transaction, Utils } from '@bsv/sdk';
import { StorageClient, StorageIdb, StorageProvider, Wallet, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import {
  installSnapshotBeef,
  restoreSpendableFirst,
  runFullSnapshot,
  SNAPSHOT_SYNC_SUFFIX,
  type SnapshotMark,
} from '../../services/spendableFirst';
import { walletOwnership } from '../../services/inboundSync';
import { FILL_MARGIN_MS, fillBackup, type FillManager } from '../../services/backupFill';
import { installFastFakeIdb } from '../fastFakeIdb';

/** Off unless asked for: it starts the storage repo's server on an embedded Postgres (minutes, another repo). */
const ON = process.env.BWX_STORAGE_E2E === '1';
const STORAGE_REPO = process.env.BWX_STORAGE_REPO ?? '/Volumes/2026/Projects/bwalletx-storage';
/** Coins on each device in the fill measurement (BWX_E2E_TXS, e.g. 5000). */
const FILL_TXS = Number(process.env.BWX_E2E_TXS ?? 200);
const DIR = import.meta.dir;
let proc: ReturnType<typeof Bun.spawn>;
let URL_: string;
let CTL: string;
let SIK: string;

const headers = new Map<number, string>();
let bad = false; // second-source headers lie (spend must be refused)
const tracker = {
  checks: 0,
  isValidRootForHeight: async (root: string, height: number) => {
    tracker.checks++;
    return !bad && headers.get(height) === root;
  },
  currentHeight: async () => 2_000_000,
};
const services = new Proxy(
  {
    chain: 'main',
    getChainTracker: async () => tracker,
    getHeight: async () => 2_000_000,
    getHeaderForHeight: async (h: number) => [
      1,
      0,
      0,
      0,
      ...new Array(32).fill(0),
      ...Utils.toArray(headers.get(h) ?? '00'.repeat(32), 'hex').reverse(),
      ...new Array(12).fill(0),
    ],
    nLockTimeIsFinal: async () => true,
    hashOutputScript: (s: string) => s,
  } as Record<string, unknown>,
  {
    get: (t, p) =>
      p in t || typeof p === 'symbol' || p === 'then'
        ? t[p as string]
        : async () => {
            throw new Error(`no network: services.${String(p)}`);
          },
  },
) as never;

const post = async (path: string, body: unknown) => {
  const r = await fetch(`${CTL}${path}`, { method: 'POST', body: JSON.stringify(body) });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
};
type Row = Record<string, unknown>;
const sql = (s: string) => post('/sql', { sql: s }) as Promise<Row[]>;

let height = 1_000_000;
async function receipt(kd: KeyDeriver, sats: number) {
  const anyone = new PrivateKey(1).toPublicKey().toString();
  const derivationPrefix = Utils.toBase64(Random(8));
  const derivationSuffix = Utils.toBase64(Random(8));
  const priv = kd.derivePrivateKey([2, '3241645161d8'], `${derivationPrefix} ${derivationSuffix}`, anyone);
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: Utils.toHex(Random(32)),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
    sequence: 0xffffffff,
  });
  tx.addOutput({ lockingScript: new P2PKH().lock(priv.toPublicKey().toAddress()), satoshis: sats });
  const txid = tx.id('hex');
  const h = ++height;
  tx.merklePath = new MerklePath(h, [[{ offset: 0, hash: txid, txid: true }]]);
  headers.set(h, txid);
  await post('/header', { height: h, root: txid });
  const beef = new Beef();
  beef.mergeTransaction(tx);
  return { txid, beef, anyone, derivationPrefix, derivationSuffix, sats };
}

let seq = 0;
async function store(name: string) {
  const s = new StorageIdb(StorageProvider.createStorageBaseOptions('main'));
  const db = `${name}-${++seq}-${Date.now()}`;
  (s as unknown as { dbName: string }).dbName = db;
  await s.migrate(db, PrivateKey.fromRandom().toPublicKey().toString());
  await s.makeAvailable();
  s.setServices(services);
  return s;
}
async function walletOn(kd: KeyDeriver, s: StorageIdb) {
  const sm = new WalletStorageManager(kd.identityKey, s);
  await sm.makeAvailable();
  sm.setServices(services);
  const wallet = new Wallet({ chain: 'main', keyDeriver: kd, storage: sm, services } as never);
  return { sm, wallet };
}
const ourClient = async (root: PrivateKey) => {
  const c = new StorageClient(new ProtoWallet(root) as never, URL_, { binaryRequests: true } as never);
  await c.makeAvailable();
  const calls: string[] = [];
  const rpc = c as unknown as { rpcCall: (m: string, p: unknown[]) => Promise<unknown> };
  const orig = rpc.rpcCall.bind(c);
  rpc.rpcCall = (m: string, p: unknown[]) => {
    calls.push(m);
    return orig(m, p);
  };
  return Object.assign(c, { calls });
};

/** The phone that holds the wallet, backed up to OUR server the way addOurBackup does it. */
async function oldDevice(root: PrivateKey, payments: number[]) {
  const kd = new KeyDeriver(root);
  const dev = await store('old');
  const { sm, wallet } = await walletOn(kd, dev);
  const receipts = [];
  for (const s of payments) {
    const r = await receipt(kd, s);
    receipts.push(r);
    await wallet.internalizeAction({
      tx: r.beef.toBinaryAtomic(r.txid),
      outputs: [
        {
          outputIndex: 0,
          protocol: 'wallet payment',
          paymentRemittance: {
            derivationPrefix: r.derivationPrefix,
            derivationSuffix: r.derivationSuffix,
            senderIdentityKey: r.anyone,
          },
        },
      ],
      description: 'payment',
    });
  }
  const c = new StorageClient(new ProtoWallet(root) as never, URL_, { binaryRequests: true } as never);
  await c.makeAvailable();
  const { user } = await c.findOrInsertUser(kd.identityKey);
  await c.setActive(
    { identityKey: kd.identityKey, userId: user.userId } as never,
    dev.getSettings().storageIdentityKey,
  );
  await sm.addWalletStorageProvider(c as never);
  expect(sm.getBackupStores()).toContain(SIK);
  expect(sm.getConflictingStores()).toEqual([]);
  await sm.updateBackups();
  return { kd, dev, sm, wallet, receipts };
}

const spendableOf = async (s: StorageIdb) => (await s.findOutputs({ partial: {} })).filter((o) => o.spendable);
const sum = (os: { satoshis: number }[]) => os.reduce((a, o) => a + o.satoshis, 0);
const pay = (w: Wallet, sats: number) =>
  w.createAction({
    description: 'a payment',
    outputs: [
      {
        lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex(),
        satoshis: sats,
        outputDescription: 'to someone',
      },
    ],
    options: { noSend: true, randomizeOutputs: false },
  });

beforeAll(async () => {
  if (!ON) return;
  // Thousands of rows: fake-indexeddb seeks like a real IndexedDB (src/testing/fastFakeIdb.ts).
  await installFastFakeIdb();
  proc = Bun.spawn([`${STORAGE_REPO}/node_modules/.bin/tsx`, `${DIR}/storageServer.ts`], {
    cwd: DIR,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error('server exited');
    buf += new TextDecoder().decode(value);
    const line = buf.split('\n').find((l) => l.startsWith('{"url"'));
    if (line) {
      const j = JSON.parse(line);
      URL_ = j.url;
      CTL = j.ctl;
      SIK = j.sik;
      expect(j.db).toBe('pg');
      break;
    }
  }
}, 60_000);
afterAll(async () => {
  if (!ON) return;
  proc.kill('SIGTERM');
  await proc.exited;
});

describe.skipIf(!ON)('E2E against the real server (Postgres)', () => {
  const PAY = [50_000, 60_000, 52_000, 55_000, 41_000, 7_000, 9_000];
  const TOTAL = PAY.reduce((a, b) => a + b, 0);
  let root: PrivateKey;
  let old: Awaited<ReturnType<typeof oldDevice>>;
  let devB: StorageIdb;
  let wB: { sm: WalletStorageManager; wallet: Wallet };
  let cB: Awaited<ReturnType<typeof ourClient>>;
  let unhook: () => void;

  test('old device backs up to our server: the server holds the coins', async () => {
    root = PrivateKey.fromRandom();
    old = await oldDevice(root, PAY);
    const rows = await sql(
      `select o.satoshis from outputs o join users u on u."userId"=o."userId" where u."identityKey"='${old.kd.identityKey}' and o.spendable`,
    );
    expect(rows.length).toBe(PAY.length);
    expect(rows.reduce((a, r) => a + Number(r.satoshis), 0)).toBe(TOTAL);
  }, 60_000);

  test('stage 1: lean restore on a fresh device gives the exact balance; real cursor untouched', async () => {
    devB = await store('new');
    wB = await walletOn(old.kd, devB);
    cB = await ourClient(root);
    const r = await restoreSpendableFirst({
      enabled: async () => true,
      client: async () => cB,
      device: () => devB,
      identityKey: async () => old.kd.identityKey,
      backupDefaultCoins: async () => PAY.length,
      log: () => undefined,
    });
    expect(r).toEqual({ used: true, coins: PAY.length, sats: TOTAL, held: 0 });
    expect(cB.calls.filter((c) => c === 'getSpendableSnapshot').length).toBeGreaterThanOrEqual(3); // paged at 3
    const sp = await spendableOf(devB);
    expect(sp.length).toBe(PAY.length);
    expect(sum(sp)).toBe(TOTAL);
    const lo = await wB.wallet.listOutputs({ basket: 'default', limit: 100 });
    expect(lo.totalOutputs).toBe(PAY.length);
    const states = await devB.findSyncStates({ partial: {} });
    expect(states.map((s) => s.storageIdentityKey)).toEqual([SIK + SNAPSHOT_SYNC_SUFFIX]);
    // lean stubs: no raw bytes, no proofs on the device yet
    for (const t of await devB.findTransactions({ partial: {} })) expect(t.rawTx?.length ?? 0).toBe(0);
    expect(await devB.findProvenTxs({ partial: {} })).toHaveLength(0);
  }, 60_000);

  test('stage 2: lying headers -> refused, nothing signed', async () => {
    unhook = installSnapshotBeef(devB, {
      client: () => cB,
      tracker: async () => tracker,
      identityKey: async () => old.kd.identityKey,
      owns: walletOwnership(root),
    });
    bad = true;
    try {
      await expect(pay(wB.wallet, 1000)).rejects.toThrow(/does not verify against the headers/);
    } finally {
      bad = false;
    }
    const signed = (await devB.findTransactions({ partial: {} })).filter(
      (t) => t.status !== 'failed' && t.rawTx?.length,
    );
    expect(signed).toHaveLength(0);
    expect((await spendableOf(devB)).length).toBe(PAY.length);
  }, 60_000);

  test('stage 2: BEEF fetched on demand from the real server, verified, payment signs and verifies', async () => {
    const before = cB.calls.length;
    tracker.checks = 0;
    const res = await pay(wB.wallet, 1000);
    expect(cB.calls.slice(before)).toContain('getBeefForOutpoints');
    expect(tracker.checks).toBeGreaterThan(0);
    const signed = Transaction.fromAtomicBEEF(res.tx!);
    expect(await signed.verify(tracker as never)).toBe(true);
  }, 60_000);

  test('stage 3: full snapshot merges with proofs; no duplicates; device pays from its own data', async () => {
    let mark: SnapshotMark = { stage: 'full', after: 0, at: 0 };
    const end = await runFullSnapshot({
      client: cB,
      device: devB,
      identityKey: old.kd.identityKey,
      serverSik: SIK,
      tracker,
      mark,
      save: async (m: SnapshotMark) => void (mark = m),
      log: () => undefined,
    });
    expect(end.stage).toBe('done');
    const outs = await devB.findOutputs({ partial: {} });
    const keys = outs.map((o) => `${o.txid}.${o.vout}`);
    expect(new Set(keys).size).toBe(keys.length);
    const proven = await devB.findProvenTxs({ partial: {} });
    expect(proven.length).toBeGreaterThan(0);
    // our server gone: still pays (BEEF from device data)
    const saved = cB.calls.length;
    unhook();
    const res = await pay(wB.wallet, 1500);
    expect(await Transaction.fromAtomicBEEF(res.tx!).verify(tracker as never)).toBe(true);
    expect(cB.calls.length).toBe(saved);
    const txids = (await devB.findTransactions({ partial: {} })).map((t) => t.txid);
    expect(new Set(txids).size).toBe(txids.length);
  }, 120_000);

  test('then today-style history sync from the server: no duplicate rows, real cursor separate', async () => {
    const c = new StorageClient(new ProtoWallet(root) as never, URL_, { binaryRequests: true } as never);
    await c.makeAvailable();
    await wB.sm.syncFromReader(old.kd.identityKey, c as never);
    const outs = await devB.findOutputs({ partial: {} });
    const keys = outs.map((o) => `${o.txid}.${o.vout}`);
    expect(new Set(keys).size).toBe(keys.length);
    const txids = (await devB.findTransactions({ partial: {} })).map((t) => t.txid);
    expect(new Set(txids).size).toBe(txids.length);
    const states = (await devB.findSyncStates({ partial: {} })).map((s) => s.storageIdentityKey).sort();
    expect(states).toEqual([SIK, SIK + SNAPSHOT_SYNC_SUFFIX].sort());
  }, 60_000);
});

describe.skipIf(!ON)('review findings, fixed (server data altered via SQL: a buggy or hostile server)', () => {
  const restoreAndFill = async (root: PrivateKey, kd: KeyDeriver, dev: StorageIdb, extra: object = {}) => {
    const c = await ourClient(root);
    const r = await restoreSpendableFirst({
      enabled: async () => true,
      client: async () => c,
      device: () => dev as never,
      identityKey: async () => kd.identityKey,
      ...extra,
    });
    return { c, r };
  };
  const stage3 = async (
    c: Awaited<ReturnType<typeof ourClient>>,
    dev: StorageIdb,
    kd: KeyDeriver,
    root: PrivateKey,
  ) => {
    let mark: SnapshotMark = { stage: 'full', after: 0, at: 0 };
    await runFullSnapshot({
      client: c as never,
      device: dev as never,
      identityKey: kd.identityKey,
      serverSik: SIK,
      tracker,
      owns: walletOwnership(root),
      mark,
      save: async (m) => void (mark = m),
    });
    return mark;
  };

  test('A: an inflated amount is refused at signing AND held; after stage 3 it is never counted', async () => {
    const root = PrivateKey.fromRandom();
    const old = await oldDevice(root, [20_000, 30_000]);
    await sql(
      `update outputs set satoshis = 3000000 where "userId" = (select "userId" from users where "identityKey"='${old.kd.identityKey}') and satoshis = 30000`,
    );
    const dev = await store('probeA');
    const w = await walletOn(old.kd, dev);
    const { c, r } = await restoreAndFill(root, old.kd, dev);
    expect(r.used).toBe(true);
    expect(sum(await spendableOf(dev))).toBe(3_020_000); // lean: the server's word until checked
    const unhook = installSnapshotBeef(dev as never, {
      client: () => c as never,
      tracker: async () => tracker,
      identityKey: async () => old.kd.identityKey,
      owns: walletOwnership(root),
    });
    await expect(pay(w.wallet, 2_500_000)).rejects.toThrow(/amount differs/);
    expect(sum(await spendableOf(dev))).toBe(20_000); // held at signing
    expect((await stage3(c, dev, old.kd, root)).stage).toBe('done');
    expect(sum(await spendableOf(dev))).toBe(20_000);
    unhook();
  }, 120_000);

  test('A2: inflated amount, no payment first: stage 3 holds it', async () => {
    const root = PrivateKey.fromRandom();
    const old = await oldDevice(root, [20_000, 30_000]);
    await sql(
      `update outputs set satoshis = 3000000 where "userId" = (select "userId" from users where "identityKey"='${old.kd.identityKey}') and satoshis = 30000`,
    );
    const dev = await store('probeA2');
    const { c } = await restoreAndFill(root, old.kd, dev);
    expect((await stage3(c, dev, old.kd, root)).stage).toBe('done');
    expect(sum(await spendableOf(dev))).toBe(20_000);
  }, 120_000);

  test('B: someone else’s coin filed under our rows: held at stage 3, never counted', async () => {
    const root = PrivateKey.fromRandom();
    const old = await oldDevice(root, [10_000]);
    const stranger = PrivateKey.fromRandom();
    const other = await oldDevice(stranger, [777_000]);
    await sql(`update outputs set "userId" = (select "userId" from users where "identityKey"='${old.kd.identityKey}'),
      "basketId" = (select "basketId" from output_baskets where name='default' and "userId"=(select "userId" from users where "identityKey"='${old.kd.identityKey}'))
      where "userId" = (select "userId" from users where "identityKey"='${other.kd.identityKey}')`);
    await sql(`update transactions set "userId" = (select "userId" from users where "identityKey"='${old.kd.identityKey}')
      where "userId" = (select "userId" from users where "identityKey"='${other.kd.identityKey}')`);
    const dev = await store('probeB');
    const { c } = await restoreAndFill(root, old.kd, dev);
    expect((await stage3(c, dev, old.kd, root)).stage).toBe('done');
    expect(sum(await spendableOf(dev))).toBe(10_000);
  }, 120_000);

  test('C: a fallback hold stays on the device: a push leaves the backup’s coins spendable', async () => {
    const root = PrivateKey.fromRandom();
    const old = await oldDevice(root, [11_000, 12_000]);
    const dev = await store('probeC');
    const w = await walletOn(old.kd, dev);
    const { r } = await restoreAndFill(root, old.kd, dev, { backupDefaultCoins: async () => 3 });
    expect(r.used).toBe(false);
    expect(await spendableOf(dev)).toHaveLength(0);
    const cc = new StorageClient(new ProtoWallet(root) as never, URL_, { binaryRequests: true } as never);
    await cc.makeAvailable();
    const { user } = await cc.findOrInsertUser(old.kd.identityKey);
    await cc.setActive(
      { identityKey: old.kd.identityKey, userId: user.userId } as never,
      dev.getSettings().storageIdentityKey,
    );
    await w.sm.addWalletStorageProvider(cc as never);
    await w.sm.updateBackups();
    const rows = await sql(
      `select spendable from outputs where "userId" = (select "userId" from users where "identityKey"='${old.kd.identityKey}')`,
    );
    expect(rows.map((x) => x.spendable)).toEqual([true, true]);
  }, 120_000);
});

describe.skipIf(!ON)(`review 4: the first push to our server (${FILL_TXS} coins)`, () => {
  /** A device with n coins, not yet backed up to our server; its user row there names it. */
  const device = async (n: number) => {
    const root = PrivateKey.fromRandom();
    const kd = new KeyDeriver(root);
    const dev = await store('fill');
    const { sm, wallet } = await walletOn(kd, dev);
    for (let i = 0; i < n; i++) {
      const r = await receipt(kd, 1000 + i);
      await wallet.internalizeAction({
        tx: r.beef.toBinaryAtomic(r.txid),
        outputs: [
          {
            outputIndex: 0,
            protocol: 'wallet payment',
            paymentRemittance: {
              derivationPrefix: r.derivationPrefix,
              derivationSuffix: r.derivationSuffix,
              senderIdentityKey: r.anyone,
            },
          },
        ],
        description: 'payment',
      });
    }
    const c = new StorageClient(new ProtoWallet(root) as never, URL_, { binaryRequests: true } as never);
    await c.makeAvailable();
    const { user } = await c.findOrInsertUser(kd.identityKey);
    await c.setActive(
      { identityKey: kd.identityKey, userId: user.userId } as never,
      dev.getSettings().storageIdentityKey,
    );
    return { kd, dev, sm, wallet, c };
  };
  /** How long a balance read waits when asked `afterMs` into a push. */
  const balanceWait = (wallet: Wallet, afterMs: number) =>
    new Promise<number>((res) =>
      setTimeout(async () => {
        const t = Date.now();
        await wallet.listOutputs({ basket: 'default', limit: 10 });
        res(Date.now() - t);
      }, afterMs),
    );
  const serverCount = async (identityKey: string) =>
    Number(
      (
        await sql(
          `select count(*) as n from outputs where "userId" = (select "userId" from users where "identityKey"='${identityKey}')`,
        )
      )[0].n,
    );

  test('toolbox push (before) vs backupFill (after): lock time and a balance read during it', async () => {
    const a = await device(FILL_TXS);
    await a.sm.addWalletStorageProvider(a.c as never);
    const t0 = Date.now();
    const readA = balanceWait(a.wallet, 200);
    await a.sm.updateBackups();
    const pushMs = Date.now() - t0;
    const waitA = await readA;
    expect(await serverCount(a.kd.identityKey)).toBe(FILL_TXS);

    const b = await device(FILL_TXS);
    // A real wallet's rows are older than the fill's margin; these were all written seconds ago.
    await new Promise((res) => setTimeout(res, FILL_MARGIN_MS + 1_000));
    const t1 = Date.now();
    const readB = balanceWait(b.wallet, 200);
    const r = await fillBackup({
      manager: b.sm as unknown as FillManager,
      reader: b.dev as never,
      writer: b.c as never,
    });
    const fillMs = Date.now() - t1;
    const waitB = await readB;
    expect(r.how).toBe('full');
    expect(await serverCount(b.kd.identityKey)).toBe(FILL_TXS);
    console.log(
      `[e2e fill ${FILL_TXS} coins] toolbox push: ${pushMs} ms, all inside the locks; balance read waited ${waitA} ms. ` +
        `backupFill: ${fillMs} ms total, ${r.unlockedPages} unlocked page(s) in ${r.unlockedMs} ms, locked ${r.lockedMs.join('+')} ms; ` +
        `balance read waited ${waitB} ms.`,
    );
    expect(Math.max(...r.lockedMs)).toBeLessThan(pushMs);
    expect(waitB).toBeLessThan(waitA);
    // The ordinary push then starts from our server's cursor.
    await b.sm.addWalletStorageProvider(b.c as never);
    const t2 = Date.now();
    await b.sm.updateBackups();
    console.log(`[e2e fill ${FILL_TXS} coins] first ordinary push after the fill: ${Date.now() - t2} ms`);
  }, 3_600_000);
});
