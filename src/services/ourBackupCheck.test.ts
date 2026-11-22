/**
 * The once-per-device check and repair of our storage server's backup (review of f5709d81: an older build could register
 * it half-filled; owner's iPhone ran build 153). Our server is left out of the session at init and joins only after the
 * check (and any repair): nothing is ever detached from a live session. Real toolbox stores on fake-indexeddb: a device
 * store with a WalletStorageManager and Wallet, our server as a second StorageIdb that the manager really registers.
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { Beef, KeyDeriver, MerklePath, P2PKH, PrivateKey, Random, Transaction, Utils } from '@bsv/sdk';
import { StorageIdb, StorageProvider, Wallet, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import { fillBackup, type FillManager } from './backupFill';
import { installInboundSyncGuard } from './inboundSync';
import {
  createSpendableFirst,
  ourBackupCheckKey,
  ourBackupInitPlan,
  type BackupCounts,
  type OurServerClient,
} from './spendableFirstWiring';

const services = {
  chain: 'main',
  getChainTracker: async () => ({ isValidRootForHeight: async () => true, currentHeight: async () => 2_000_000 }),
  getHeight: async () => 2_000_000,
  getHeaderForHeight: async () => new Array(80).fill(0),
  nLockTimeIsFinal: async () => true,
} as never;

let seq = 0;
const store = async (name: string) => {
  const s = new StorageIdb(StorageProvider.createStorageBaseOptions('main'));
  const db = `ourcheck-${name}-${++seq}-${Date.now()}`;
  (s as unknown as { dbName: string }).dbName = db;
  await s.migrate(db, `sik-${db}`);
  await s.makeAvailable();
  s.setServices(services);
  return s;
};

let height = 960_000;
const mined = (address: string, sats: number) => {
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: Utils.toHex(Random(32)),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()),
    sequence: 0xffffffff,
  });
  tx.addOutput({ lockingScript: new P2PKH().lock(address), satoshis: sats });
  return tx;
};
async function receive(w: Wallet, kd: KeyDeriver, sats: number) {
  const anyone = new PrivateKey(1).toPublicKey().toString();
  const derivationPrefix = Utils.toBase64(Random(8));
  const derivationSuffix = Utils.toBase64(Random(8));
  const priv = kd.derivePrivateKey([2, '3241645161d8'], `${derivationPrefix} ${derivationSuffix}`, anyone);
  const tx = mined(priv.toPublicKey().toAddress(), sats);
  const txid = tx.id('hex');
  tx.merklePath = new MerklePath(++height, [[{ offset: 0, hash: txid, txid: true }]]);
  const beef = new Beef();
  beef.mergeTransaction(tx);
  await w.internalizeAction({
    tx: beef.toBinaryAtomic(txid),
    outputs: [
      {
        outputIndex: 0,
        protocol: 'wallet payment',
        paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: anyone },
      },
    ],
    description: 'payment',
  });
  return txid;
}
async function token(w: Wallet) {
  const tx = mined(PrivateKey.fromRandom().toAddress(), 1);
  const txid = tx.id('hex');
  tx.merklePath = new MerklePath(++height, [[{ offset: 0, hash: txid, txid: true }]]);
  const beef = new Beef();
  beef.mergeTransaction(tx);
  await w.internalizeAction({
    tx: beef.toBinaryAtomic(txid),
    outputs: [{ outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket: 'tokens' } }],
    description: 'a token',
  });
}

/** A device whose wallet has `n` coins, and our server filled from it once (whole at that time). */
async function setup(n: number) {
  const kd = new KeyDeriver(PrivateKey.fromRandom());
  const dev = await store('dev');
  const server = await store('server');
  const sm = new WalletStorageManager(kd.identityKey, dev);
  await sm.makeAvailable();
  sm.setServices(services);
  const wallet = new Wallet({ chain: 'main', keyDeriver: kd, storage: sm, services } as never);
  for (let i = 0; i < n; i++) await receive(wallet, kd, 1000 + i);
  const { user } = await server.findOrInsertUser(kd.identityKey);
  await server.setActive(
    { identityKey: kd.identityKey, userId: user.userId } as never,
    dev.getSettings().storageIdentityKey,
  );
  await fillBackup({ manager: sm as unknown as FillManager, reader: dev, writer: server, pageGapMs: 0 });
  return { kd, dev, server, sm, wallet };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** What the device holds, as rows: each output with its spendable flag and basket, transactions, certificates. */
const rows = async (s: StorageIdb) => {
  const names = new Map((await s.findOutputBaskets({ partial: {} })).map((b) => [b.basketId, b.name]));
  return {
    outputs: (await s.findOutputs({ partial: {} }))
      .map((o) => `${o.txid}.${o.vout}:${o.spendable}:${names.get(o.basketId!) ?? '-'}`)
      .sort(),
    transactions: (await s.findTransactions({ partial: {} })).map((t) => `${t.txid}:${t.status}`).sort(),
    certificates: (await s.findCertificates({ partial: {} })).map((c) => `${c.type}:${c.serialNumber}`).sort(),
  };
};

const deviceCounts = (x: Setup) => async (): Promise<BackupCounts> => {
  const { userId } = await x.sm.getAuth();
  const baskets: Record<string, number> = {};
  for (const b of await x.dev.findOutputBaskets({ partial: { userId: userId! } }))
    baskets[b.name] = (await x.wallet.listOutputs({ basket: b.name, limit: 1 })).totalOutputs;
  return {
    actions: (await x.wallet.listActions({ labels: [], limit: 1 })).totalActions,
    certificates: (await x.wallet.listCertificates({ certifiers: [], types: [], limit: 1 })).totalCertificates,
    baskets,
  };
};

/**
 * One wallet init with our server deferred: the wiring as initWallet builds it, over the real stores. `addRemote` is the
 * real registration (the manager's addWalletStorageProvider); the fill is the real fillBackup.
 */
function init(
  x: Setup,
  kv: Record<string, unknown>,
  o: {
    client?: (c: OurServerClient) => OurServerClient;
    fill?: (run: () => Promise<unknown>) => Promise<unknown>;
    on?: boolean;
  } = {},
) {
  const log = { fills: [] as { full?: boolean; unfinished?: boolean }[], attached: 0 };
  const client = () => (o.client ? o.client(x.server as unknown as OurServerClient) : x.server) as OurServerClient;
  const w = createSpendableFirst({
    on: o.on ?? true,
    newClient: client,
    device: () => x.dev as never,
    identityKey: async () => x.kd.identityKey,
    deviceActive: () => true,
    tracker: async () => ({ isValidRootForHeight: async () => true }),
    remoteDefaultCoins: async () => 0,
    makeDeviceActive: async () => undefined,
    withLock: (fn) => fn(),
    fill: async (writer, restorePoint, f) => {
      log.fills.push({ full: f?.full, unfinished: f?.unfinished });
      const run = async () => {
        const unguard = installInboundSyncGuard(StorageIdb);
        try {
          return await fillBackup({
            manager: x.sm as unknown as FillManager,
            reader: x.dev,
            writer: writer as never,
            restorePoint,
            pageGapMs: 0,
            ...f,
          });
        } finally {
          unguard();
        }
      };
      return (o.fill ? o.fill(run) : run()) as never;
    },
    addRemote: async () => {
      await x.sm.addWalletStorageProvider(x.server);
      log.attached++;
    },
    registered: () => log.attached > 0,
    deferred: true,
    deviceCounts: deviceCounts(x),
    sleep: async () => undefined,
    kv: { get: async (k) => ({ [k]: kv[k] }), set: async (i) => void Object.assign(kv, i) },
    markKey: 'mark',
  });
  return { w, log };
}
const KEY = ourBackupCheckKey('mark');
const serverIn = (x: Setup) => x.sm.getBackupStores().includes(x.server.getSettings().storageIdentityKey);

/** The device moves on while our server hears nothing: a token basket, a coin spent, a certificate. */
async function halfFill(x: Setup) {
  await token(x.wallet);
  const [coin] = await x.dev.findOutputs({ partial: { spendable: true } });
  await x.dev.updateOutput(coin.outputId, { spendable: false, updated_at: new Date() } as never);
  const { userId } = await x.sm.getAuth();
  const now = new Date();
  await x.dev.insertCertificate({
    created_at: now,
    updated_at: now,
    certificateId: 0,
    userId: userId!,
    type: Utils.toBase64(Random(32)),
    serialNumber: Utils.toBase64(Random(32)),
    certifier: PrivateKey.fromRandom().toPublicKey().toString(),
    subject: x.kd.identityKey,
    revocationOutpoint: `${Utils.toHex(Random(32))}.0`,
    signature: '3045',
    isDeleted: false,
  } as never);
}

describe('our server joins the session only after its check: whole, or repaired first', () => {
  test('at init: deferred until checked; a whole or repaired record joins at once; an unreadable record joins', async () => {
    const kv = { get: async (k: string) => ({ [k]: store_[k] }) };
    const store_: Record<string, unknown> = {};
    expect(await ourBackupInitPlan(kv, 'mark', 'sik')).toBe('defer');
    store_[KEY] = { deviceSik: 'sik', check: 'repair-pending', full: true, at: 1 };
    expect(await ourBackupInitPlan(kv, 'mark', 'sik')).toBe('defer');
    store_[KEY] = { deviceSik: 'sik', check: 'match', at: 1 };
    expect(await ourBackupInitPlan(kv, 'mark', 'sik')).toBe('attach');
    // Another device store's record doesn't count.
    expect(await ourBackupInitPlan(kv, 'mark', 'other')).toBe('defer');
    const broken = { get: async () => Promise.reject(new Error('storage unavailable')) };
    expect(await ourBackupInitPlan(broken, 'mark', 'sik')).toBe('attach');
  });

  test('a whole backup: match recorded, no fill, our server joins the session for real', async () => {
    const x = await setup(3);
    const kv: Record<string, unknown> = {};
    const { w, log } = init(x, kv);
    expect(await w.ensureOurBackup()).toBe(true);
    expect((kv[KEY] as { check: string }).check).toBe('match');
    expect(log.fills).toEqual([]);
    expect(serverIn(x)).toBe(true);
  });

  test('(e) half-filled (a token basket, a coin spent here still spendable there, a certificate): repaired row for row', async () => {
    const x = await setup(4);
    await halfFill(x);
    expect(await rows(x.server)).not.toEqual(await rows(x.dev));
    const kv: Record<string, unknown> = {};
    const { w, log } = init(x, kv);
    expect(await w.ensureOurBackup()).toBe(true);
    expect(log.fills).toEqual([{ full: true, unfinished: true }]);
    expect(await rows(x.server)).toEqual(await rows(x.dev));
    expect((kv[KEY] as { check: string }).check).toBe('repaired');
    expect(serverIn(x)).toBe(true);
  });

  test('(a) a close right after the repair is recorded: the next init repeats the repair (resume keeps it)', async () => {
    const x = await setup(3);
    await halfFill(x);
    const kv: Record<string, unknown> = {};
    // Init 1: the decision is written, then the wallet closes before the fill ends.
    const one = init(x, kv, { fill: () => new Promise(() => undefined) });
    void one.w.ensureOurBackup();
    for (let i = 0; i < 200 && (kv[KEY] as { check?: string } | undefined)?.check !== 'repair-pending'; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(kv[KEY]).toMatchObject({ check: 'repair-pending', full: true });
    one.w.stop();
    expect(serverIn(x)).toBe(false);
    // Init 2: still deferred; resume never clears the pending repair; the repair runs and our server joins.
    expect(
      await ourBackupInitPlan({ get: async (k) => ({ [k]: kv[k] }) }, 'mark', x.dev.getSettings().storageIdentityKey),
    ).toBe('defer');
    const two = init(x, kv);
    await two.w.resume();
    expect(kv[KEY]).toMatchObject({ check: 'repair-pending' });
    expect(await two.w.ensureOurBackup()).toBe(true);
    expect(two.log.fills).toEqual([{ full: true, unfinished: true }]);
    expect(await rows(x.server)).toEqual(await rows(x.dev));
    expect((kv[KEY] as { check: string }).check).toBe('repaired');
  });

  test('(b) after the refill our server is really in the session: an ordinary push reaches it', async () => {
    const x = await setup(3);
    await halfFill(x);
    const kv: Record<string, unknown> = {};
    const { w } = init(x, kv);
    expect(await w.ensureOurBackup()).toBe(true);
    expect(serverIn(x)).toBe(true);
    const fresh = await receive(x.wallet, x.kd, 4321);
    expect((await x.server.findTransactions({ partial: { txid: fresh } })).length).toBe(0);
    await x.sm.updateBackups();
    expect((await x.server.findTransactions({ partial: { txid: fresh } })).length).toBe(1);
  });

  test('(c) our server can’t be read: no repair, our server joins as before, the check runs again next init', async () => {
    const x = await setup(3);
    await halfFill(x);
    const kv: Record<string, unknown> = {};
    const failing = (c: OurServerClient) =>
      Object.assign(Object.create(c), { listActions: async () => Promise.reject(new Error('network error 503')) });
    const { w, log } = init(x, kv, { client: failing });
    expect(await w.ensureOurBackup()).toBe(true);
    expect(log.fills).toEqual([]);
    expect(kv[KEY]).toBeUndefined();
    expect(serverIn(x)).toBe(true);
  });

  test('(d) two inits at once: one check; each session gets our server', async () => {
    const x = await setup(3);
    const kv: Record<string, unknown> = {};
    let reads = 0;
    const counting = (c: OurServerClient) =>
      Object.assign(Object.create(c), {
        listActions: (...a: unknown[]) => (reads++, (c.listActions as (...a: unknown[]) => unknown).apply(c, a)),
      });
    const a = init(x, kv, { client: counting });
    const b = init(x, kv, { client: counting });
    const [ra, rb] = await Promise.all([a.w.ensureOurBackup(), b.w.ensureOurBackup()]);
    expect([ra, rb]).toEqual([true, true]);
    expect(reads).toBe(1);
    expect(a.log.attached + b.log.attached).toBe(2);
  });

  test('flag off: nothing to do, nothing read, nothing joined', async () => {
    const x = await setup(1);
    let reads = 0;
    const counting = (c: OurServerClient) =>
      Object.assign(Object.create(c), { listActions: async () => (reads++, { totalActions: 0 }) });
    const { w, log } = init(x, {}, { client: counting, on: false });
    expect(await w.ensureOurBackup()).toBe(true);
    expect([reads, log.fills.length, log.attached]).toEqual([0, 0, 0]);
  });
});
