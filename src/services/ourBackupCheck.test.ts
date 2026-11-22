/**
 * The one-time repair of our storage server's backup (an older build could register it half-filled; owner's iPhone ran
 * build 153). No count heuristic (review of 8ee88600): any device with our server saved and no 'repaired' record gets
 * the whole two-pass fill once. Our server is held out of the session until it finishes; nothing is ever detached. Real toolbox stores on fake-indexeddb: a device
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
  OUR_BACKUP_REBUILDING_REFUSAL,
  OUR_SERVER_ACTIVE_REFUSAL,
  makeActiveRefusal,
  ourBackupFailedRefusal,
  type OurServerClient,
} from './spendableFirstWiring';
import { backupBeforeSend } from './deviceSync';
import { createChangeWriteAhead } from './changeWriteAhead';
import { createInFlight } from './pushView';
import {
  addRemoteRefusal,
  backupsFor,
  forgetDeviceStoreRecords,
  isOurServer,
  normalizeStoreConfig,
  OUR_SERVER_ADD_REFUSAL,
  repairSyncRemote,
  SNAPSHOT_SERVER_URL,
  withSnapshotRemote,
} from './spendableFirst';

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
async function token(w: Wallet, o: { tags?: string[]; labels?: string[] } = {}) {
  const tx = mined(PrivateKey.fromRandom().toAddress(), 1);
  const txid = tx.id('hex');
  tx.merklePath = new MerklePath(++height, [[{ offset: 0, hash: txid, txid: true }]]);
  const beef = new Beef();
  beef.mergeTransaction(tx);
  await w.internalizeAction({
    tx: beef.toBinaryAtomic(txid),
    outputs: [
      { outputIndex: 0, protocol: 'basket insertion', insertionRemittance: { basket: 'tokens', tags: o.tags } },
    ],
    labels: o.labels,
    description: 'a token',
  });
}

/** A device whose wallet has `n` coins, and our server filled from it once (whole at that time). */
async function setup(n: number, o: { filled?: boolean } = {}) {
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
  if (o.filled !== false)
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
    ...(await maps(s)),
  };
};
/** Label and tag maps, by txid and label or tag name (what listActions/listOutputs filter on). */
const maps = async (s: StorageIdb) => {
  const txid = new Map((await s.findTransactions({ partial: {} })).map((t) => [t.transactionId, t.txid]));
  const out = new Map((await s.findOutputs({ partial: {} })).map((o) => [o.outputId, `${o.txid}.${o.vout}`]));
  const label = new Map((await s.findTxLabels({ partial: {} })).map((l) => [l.txLabelId, l.label]));
  const tag = new Map((await s.findOutputTags({ partial: {} })).map((t) => [t.outputTagId, t.tag]));
  return {
    labelMaps: (await s.findTxLabelMaps({ partial: {} }))
      .filter((m) => !m.isDeleted)
      .map((m) => `${txid.get(m.transactionId)}:${label.get(m.txLabelId)}`)
      .sort(),
    tagMaps: (await s.findOutputTagMaps({ partial: {} }))
      .filter((m) => !m.isDeleted)
      .map((m) => `${out.get(m.outputId)}:${tag.get(m.outputTagId)}`)
      .sort(),
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
    deferred?: boolean;
    kvGet?: (k: string) => Promise<Record<string, unknown>>;
    busy?: () => boolean;
    flushUnbacked?: () => Promise<unknown>;
    now?: () => number;
    report?: (text: string) => void;
    deviceActive?: () => boolean;
  } = {},
) {
  const log = { fills: [] as { full?: boolean; unfinished?: boolean }[], attached: 0 };
  const client = () => (o.client ? o.client(x.server as unknown as OurServerClient) : x.server) as OurServerClient;
  const w = createSpendableFirst({
    on: o.on ?? true,
    newClient: client,
    device: () => x.dev as never,
    identityKey: async () => x.kd.identityKey,
    deviceActive: o.deviceActive ?? (() => true),
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
    deferred: o.deferred ?? true,
    busy: o.busy,
    flushUnbacked: o.flushUnbacked,
    now: o.now,
    report: o.report,
    sleep: async () => undefined,
    kv: { get: o.kvGet ?? (async (k) => ({ [k]: kv[k] })), set: async (i) => void Object.assign(kv, i) },
    markKey: 'mark',
  });
  return { w, log };
}
const KEY = ourBackupCheckKey('mark');
/** A payment of this wallet's own (signed, its broadcast left to the Monitor): spent coins, change, transaction rows. */
async function send(x: Setup) {
  const r = await x.wallet.createAction({
    description: 'a send during the fill',
    outputs: [
      {
        lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex(),
        satoshis: 500,
        outputDescription: 'to someone',
      },
    ],
    options: { acceptDelayedBroadcast: true },
  });
  return r.txid!;
}
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
};
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

describe('our server’s one-time repair: held out of the session until the whole fill has run', () => {
  test('at init: held out until a fill finished on this device; an unreadable record is held out too', async () => {
    const store_: Record<string, unknown> = {};
    const kv = { get: async (k: string) => ({ [k]: store_[k] }) };
    expect(await ourBackupInitPlan(kv, 'mark', 'sik')).toBe('defer');
    store_[KEY] = { deviceSik: 'sik', check: 'repair-pending', full: true, at: 1 };
    expect(await ourBackupInitPlan(kv, 'mark', 'sik')).toBe('defer');
    store_[KEY] = { deviceSik: 'sik', check: 'repaired', at: 1 };
    expect(await ourBackupInitPlan(kv, 'mark', 'sik')).toBe('attach');
    expect(await ourBackupInitPlan(kv, 'mark', 'other')).toBe('defer');
    // Unreadable: held out too (review of b936a98c, 2); never joined unrepaired. The repair's own read retries.
    const broken = { get: async () => Promise.reject(new Error('storage unavailable')) };
    expect(await ourBackupInitPlan(broken, 'mark', 'sik')).toBe('defer');
  });

  test('R1 (review of b936a98c, 1): an older build filled once, the device moved on: the first fill by this build runs whole', async () => {
    const x = await setup(3);
    await halfFill(x);
    const kv: Record<string, unknown> = {};
    const first = init(x, kv, { deferred: false });
    expect(await first.w.addOurBackup()).toBe(true);
    // Never "not-needed" on the cursor the older build left: the whole two-pass fill, then 'repaired'.
    expect(first.log.fills).toEqual([{ full: true, unfinished: true }]);
    expect(await rows(x.server)).toEqual(await rows(x.dev));
    expect(kv[KEY]).toMatchObject({ check: 'repaired' });
  });

  for (const how of ['not-needed', 'restore-point'] as const)
    test(`a fill that answered ${how} never records 'repaired': our server stays out, the next init runs the whole fill`, async () => {
      const x = await setup(3);
      await halfFill(x);
      const kv: Record<string, unknown> = {};
      const short = { how, pages: 0, unlockedPages: 0, unlockedMs: 0, lockedMs: [] };
      const first = init(x, kv, { deferred: false, fill: async () => short });
      expect(await first.w.addOurBackup()).toBe(false);
      expect((kv[KEY] as { check?: string } | undefined)?.check).not.toBe('repaired');
      expect(serverIn(x)).toBe(false);
      expect(first.w.ourBackup().incomplete).toBe(true);
      first.w.stop();
      const sik = x.dev.getSettings().storageIdentityKey;
      expect(await ourBackupInitPlan({ get: async (k) => ({ [k]: kv[k] }) }, 'mark', sik)).toBe('defer');
      delete kv['mark:ourBackupFill']; // its back-off, so this test needn't wait
      const next = init(x, kv);
      expect(await next.w.ensureOurBackup()).toBe(true);
      expect(next.log.fills).toEqual([{ full: true, unfinished: true }]);
      expect(await rows(x.server)).toEqual(await rows(x.dev));
      expect(kv[KEY]).toMatchObject({ check: 'repaired' });
    });

  test('a whole backup gets the fill once too (idempotent): repaired, our server joins for real', async () => {
    const x = await setup(3);
    const before = await rows(x.server);
    const kv: Record<string, unknown> = {};
    const { w, log } = init(x, kv);
    expect(await w.ensureOurBackup()).toBe(true);
    expect(log.fills).toEqual([{ full: true, unfinished: true }]);
    expect(await rows(x.server)).toEqual(before);
    expect((kv[KEY] as { check: string }).check).toBe('repaired');
    expect(serverIn(x)).toBe(true);
  });

  test('half-filled (token basket, a coin spent here still spendable there, a certificate): repaired row for row', async () => {
    const x = await setup(4);
    await halfFill(x);
    expect(await rows(x.server)).not.toEqual(await rows(x.dev));
    const kv: Record<string, unknown> = {};
    const { w } = init(x, kv);
    expect(await w.ensureOurBackup()).toBe(true);
    expect(await rows(x.server)).toEqual(await rows(x.dev));
  });

  test('(c) a label map and a tag map our server lacks are there after the repair', async () => {
    const x = await setup(2);
    await token(x.wallet, { tags: ['gold'], labels: ['bmint'] });
    const lacking = await maps(x.server);
    expect(lacking.labelMaps.some((m) => m.endsWith(':bmint'))).toBe(false);
    expect(lacking.tagMaps.some((m) => m.endsWith(':gold'))).toBe(false);
    const { w } = init(x, {});
    expect(await w.ensureOurBackup()).toBe(true);
    const after = await maps(x.server);
    expect(after).toEqual(await maps(x.dev));
    expect(after.labelMaps.some((m) => m.endsWith(':bmint'))).toBe(true);
    expect(after.tagMaps.some((m) => m.endsWith(':gold'))).toBe(true);
  });

  test('(a) our server the only backup, held out: a Store payment is refused with the honest line, never "no backup"', async () => {
    const x = await setup(2);
    await halfFill(x);
    const { w } = init(x, {});
    const configured = [SNAPSHOT_SERVER_URL];
    let session: string[] = [];
    let pushes = 0;
    // As initWallet wires it: configured backups (fail closed), our server held out with no other backup in session.
    const pay = () =>
      backupBeforeSend({
        deviceActive: () => true,
        backupConfigured: () => configured.length > 0,
        heldOut: () => w.heldOutRefusal(session.some((u) => u !== SNAPSHOT_SERVER_URL)),
        pushNow: async () => (pushes++, { ok: true, pulled: false, pushed: true }),
        log: () => undefined,
      });
    expect(await pay()).toEqual({ ok: false, error: 'Your backup is being rebuilt. Try again in a few minutes.' });
    expect(pushes).toBe(0);
    // Another backup in the session: payments go on as normal.
    session = ['https://wallet.1sat.app'];
    expect(await pay()).toEqual({ ok: true, how: 'pushed' });
    // The repair done, our server in the session: as normal too.
    session = [];
    expect(await w.ensureOurBackup()).toBe(true);
    expect(w.heldOut()).toBe(false);
    expect(await pay()).toEqual({ ok: true, how: 'pushed' });
  });

  test('(b) a fresh first fill by this build records it with the registration: the next init joins without a fill', async () => {
    const x = await setup(3, { filled: false });
    const kv: Record<string, unknown> = {};
    const first = init(x, kv, { deferred: false });
    expect(await first.w.addOurBackup()).toBe(true);
    expect(kv[KEY]).toMatchObject({ check: 'repaired', deviceSik: x.dev.getSettings().storageIdentityKey });
    const plan = await ourBackupInitPlan(
      { get: async (k) => ({ [k]: kv[k] }) },
      'mark',
      x.dev.getSettings().storageIdentityKey,
    );
    expect(plan).toBe('attach');
  });

  test('(d) a crash mid-repair: the next init resumes it (resume keeps the pending repair)', async () => {
    const x = await setup(3);
    await halfFill(x);
    const kv: Record<string, unknown> = {};
    const one = init(x, kv, { fill: () => new Promise(() => undefined) });
    void one.w.ensureOurBackup();
    for (let i = 0; i < 200 && (kv[KEY] as { check?: string } | undefined)?.check !== 'repair-pending'; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(kv[KEY]).toMatchObject({ check: 'repair-pending', full: true });
    one.w.stop();
    expect(serverIn(x)).toBe(false);
    const sik = x.dev.getSettings().storageIdentityKey;
    expect(await ourBackupInitPlan({ get: async (k) => ({ [k]: kv[k] }) }, 'mark', sik)).toBe('defer');
    const two = init(x, kv);
    await two.w.resume();
    expect(kv[KEY]).toMatchObject({ check: 'repair-pending' });
    expect(await two.w.ensureOurBackup()).toBe(true);
    expect(two.log.fills).toEqual([{ full: true, unfinished: true }]);
    expect(await rows(x.server)).toEqual(await rows(x.dev));
    expect((kv[KEY] as { check: string }).check).toBe('repaired');
  });

  test('(e) STORAGE_REPAIR_SYNC during the repair never reconciles with our server', () => {
    const only = { remotes: [SNAPSHOT_SERVER_URL] };
    const both = { remotes: [SNAPSHOT_SERVER_URL, 'https://wallet.1sat.app'] };
    expect(repairSyncRemote(only, true, true)).toBeUndefined();
    expect(repairSyncRemote(both, true, true)).toBe('https://wallet.1sat.app');
    // Repaired (or not held out): as before, the first remote.
    expect(repairSyncRemote(both, false, true)).toBe(SNAPSHOT_SERVER_URL);
    expect(repairSyncRemote({ activeRemote: 'https://x.example', remotes: [] }, true, true)).toBe('https://x.example');
  });

  test('review of f42df01f, 4: flag off, Repair Sync never connects our server (even first in the saved remotes)', () => {
    const both = { remotes: [SNAPSHOT_SERVER_URL, 'https://wallet.1sat.app'] };
    expect(repairSyncRemote(both, false, false)).toBe('https://wallet.1sat.app');
    expect(repairSyncRemote({ remotes: [SNAPSHOT_SERVER_URL] }, false, false)).toBeUndefined();
    // The account's active store is its store, flag or not.
    expect(repairSyncRemote({ activeRemote: SNAPSHOT_SERVER_URL, remotes: [] }, false, false)).toBe(
      SNAPSHOT_SERVER_URL,
    );
  });

  test('review of f42df01f, 3: Settings › Storage can never add our server by hand (no fill, no hold-out)', () => {
    for (const url of [
      SNAPSHOT_SERVER_URL,
      `${SNAPSHOT_SERVER_URL}/`,
      'HTTPS://Storage.bwalletx.com',
      'https://storage.bwalletx.com:443',
    ])
      expect(addRemoteRefusal(url)).toBe(OUR_SERVER_ADD_REFUSAL);
    expect(OUR_SERVER_ADD_REFUSAL).toMatch(/^[^:]+\.$/); // one plain sentence
    expect(addRemoteRefusal('https://wallet.1sat.app')).toBeUndefined();
    expect(addRemoteRefusal('not a url')).toBeUndefined();
  });

  /** Our server's URL as a saved remote could be spelled (review of 6888544a, 2). */
  const SPELLINGS = [
    SNAPSHOT_SERVER_URL,
    `${SNAPSHOT_SERVER_URL}/`,
    'HTTPS://Storage.bwalletx.com',
    'https://storage.bwalletx.com:443',
    'https://storage.bwalletx.com.',
    'https://storage.bwalletx.com..',
    'https://storage.bwalletx.com%2e',
    'https://storage.bwalletx.com%2E/',
    'https://%73torage.bwalletx.com',
  ];
  test('review of 6888544a, 2: one isOurServer for every spelling; every check uses it; saved remotes normalised', () => {
    for (const u of SPELLINGS) {
      expect([u, isOurServer(u)]).toEqual([u, true]);
      expect(addRemoteRefusal(u)).toBe(OUR_SERVER_ADD_REFUSAL);
      expect(backupsFor([u, 'https://wallet.1sat.app'], false)).toEqual(['https://wallet.1sat.app']);
      expect(repairSyncRemote({ remotes: [u, 'https://wallet.1sat.app'] }, true, true)).toBe('https://wallet.1sat.app');
      expect(repairSyncRemote({ remotes: [u, 'https://wallet.1sat.app'] }, false, false)).toBe(
        'https://wallet.1sat.app',
      );
      const c = { remotes: ['https://wallet.1sat.app', u] };
      expect(withSnapshotRemote(normalizeStoreConfig(c), true)).toEqual({
        remotes: ['https://wallet.1sat.app', SNAPSHOT_SERVER_URL],
      });
      expect(normalizeStoreConfig({ activeRemote: u, remotes: [u, SNAPSHOT_SERVER_URL] })).toEqual({
        activeRemote: SNAPSHOT_SERVER_URL,
        remotes: [SNAPSHOT_SERVER_URL],
      });
    }
    for (const u of [
      'https://wallet.1sat.app',
      'https://storage.bwalletx.com.evil.example',
      'https://evilstorage.bwalletx.com',
      'https://storage.bwalletx.com:8443',
      'not a url',
    ])
      expect([u, isOurServer(u)]).toEqual([u, false]);
    // Nothing to change: the same object back.
    const plain = { remotes: ['https://wallet.1sat.app'] };
    expect(normalizeStoreConfig(plain)).toBe(plain);
  });

  test('review of 6888544a, 1: "Make active" refuses our server unless the flag is on and this device repaired it', async () => {
    const kvOf = (v: unknown) => ({ get: async (k: string) => ({ [k]: v }) });
    const repaired = { deviceSik: 'dev', check: 'repaired', at: 1 };
    const ask = (url: string, flagOn: boolean, rec: unknown, deviceSik: string | undefined = 'dev') =>
      makeActiveRefusal(url, { flagOn, kv: kvOf(rec), markKey: 'mark', deviceSik });
    for (const u of SPELLINGS) {
      expect(await ask(u, false, repaired)).toBe(OUR_SERVER_ACTIVE_REFUSAL);
      expect(await ask(u, true, undefined)).toBe(OUR_SERVER_ACTIVE_REFUSAL);
      expect(await ask(u, true, { ...repaired, check: 'repair-pending' })).toBe(OUR_SERVER_ACTIVE_REFUSAL);
      expect(await ask(u, true, { ...repaired, deviceSik: 'other' })).toBe(OUR_SERVER_ACTIVE_REFUSAL);
      expect(
        await makeActiveRefusal(u, { flagOn: true, kv: kvOf(repaired), markKey: 'mark', deviceSik: undefined }),
      ).toBe(OUR_SERVER_ACTIVE_REFUSAL);
      expect(await ask(u, true, repaired)).toBeUndefined();
    }
    const broken = { get: async () => Promise.reject(new Error('storage unavailable')) };
    expect(
      await makeActiveRefusal(SNAPSHOT_SERVER_URL, { flagOn: true, kv: broken, markKey: 'mark', deviceSik: 'dev' }),
    ).toBe(OUR_SERVER_ACTIVE_REFUSAL);
    expect(await ask('https://wallet.1sat.app', false, undefined)).toBeUndefined();
    expect(await ask('local', false, undefined)).toBeUndefined();
    expect(OUR_SERVER_ACTIVE_REFUSAL).toMatch(/^[^:]+\.$/);
  });

  test('review of 6888544a, 3: signing out forgets the install key and every repair record, nothing else', async () => {
    const store: Record<string, unknown> = {
      storageIdentityKey: 'yours-abc',
      'bwxSpendableSnapshot:1A:ourBackupCheck': { check: 'repaired' },
      'bwxSpendableSnapshot:1B:ourBackupCheck': { check: 'repair-pending' },
      'bwxSpendableSnapshot:1A:ourBackupFill': { progress: null },
      'bwxSpendableSnapshot:1A': { stage: 'done' },
      accounts: { keep: true },
    };
    const area = {
      get: async (k: null) => (k === null ? { ...store } : {}),
      remove: async (keys: string[]) => {
        for (const k of keys) delete store[k];
      },
    };
    await forgetDeviceStoreRecords(area);
    expect(Object.keys(store).sort()).toEqual([
      'accounts',
      'bwxSpendableSnapshot:1A',
      'bwxSpendableSnapshot:1A:ourBackupFill',
    ]);
  });

  test('review of f42df01f, 2: "rebuilding" only while this device is active (the repair can run)', async () => {
    const x = await setup(2);
    let active = false;
    const { w } = init(x, {}, { deviceActive: () => active });
    expect(w.heldOut()).toBe(true);
    // Remote-active: ensureOurBackup can't run, so no "rebuilding" line.
    expect(w.ourBackup()).toEqual({ incomplete: false });
    active = true;
    expect(w.ourBackup()).toMatchObject({ incomplete: true, rebuilding: { rows: 0 } });
  });

  test('after the repair our server is really in the session: an ordinary push reaches it', async () => {
    const x = await setup(3);
    await halfFill(x);
    const { w } = init(x, {});
    expect(await w.ensureOurBackup()).toBe(true);
    const fresh = await receive(x.wallet, x.kd, 4321);
    await x.sm.updateBackups();
    expect((await x.server.findTransactions({ partial: { txid: fresh } })).length).toBe(1);
  });

  test('a payment of its own going, or the record unreadable: not now (never joined unchecked), a retry is kept', async () => {
    const x = await setup(2);
    const busy = init(x, {}, { busy: () => true });
    expect(await busy.w.ensureOurBackup()).toBe(false);
    expect(busy.log.fills).toEqual([]);
    expect(serverIn(x)).toBe(false);
    expect(busy.w.ourBackup().retryAt).toBeGreaterThan(Date.now());
    const broken = init(x, {}, { kvGet: async () => Promise.reject(new Error('storage unavailable')) });
    expect(await broken.w.ensureOurBackup()).toBe(false);
    expect(serverIn(x)).toBe(false);
  });

  test('two inits at once: one fill; each session gets our server', async () => {
    const x = await setup(3);
    const kv: Record<string, unknown> = {};
    const a = init(x, kv);
    const b = init(x, kv);
    const [ra, rb] = await Promise.all([a.w.ensureOurBackup(), b.w.ensureOurBackup()]);
    expect([ra, rb]).toEqual([true, true]);
    expect(a.log.fills.length + b.log.fills.length).toBe(1);
    expect(a.log.attached + b.log.attached).toBe(2);
  });

  test('(4a) a send during the bulk pass is on our server after the fill: the final pass takes it', async () => {
    const x = await setup(3);
    await halfFill(x);
    let sent: string | undefined;
    let pages = 0;
    const { w } = init(
      x,
      {},
      {
        client: (c) =>
          new Proxy(c, {
            get(t, p) {
              const v = Reflect.get(t, p, t) as unknown;
              if (p !== 'processSyncChunk') return typeof v === 'function' ? v.bind(t) : v;
              return async (...a: unknown[]) => {
                // The first page is the bulk pass's (no locks held): a payment goes out beside it.
                if (pages++ === 0) sent = await send(x);
                return (v as (...b: unknown[]) => unknown).apply(t, a);
              };
            },
          }),
      },
    );
    expect(await w.ensureOurBackup()).toBe(true);
    expect(sent).toBeDefined();
    expect((await x.server.findTransactions({ partial: { txid: sent } })).length).toBe(1);
    expect(await rows(x.server)).toEqual(await rows(x.dev));
  });

  test('(4b) a payment flagged "not backed up yet" while our server was held out: the flag clears once it joins', async () => {
    const x = await setup(2);
    await halfFill(x);
    const managed = x.sm as unknown as { _backups?: { storage: unknown }[] };
    const wa = createChangeWriteAhead({
      applies: () => true,
      backups: () => managed._backups ?? [],
      storage: x.sm as never,
      inFlightFor: () => createInFlight(),
      // As the device sync's push: nothing in the session, nothing pushed.
      pushNow: async () => {
        const n = x.sm.getBackupStores().length;
        if (n) await x.sm.updateBackups();
        return { ok: true, pulled: false, pushed: n > 0 };
      },
      retryTimer: { set: () => 0, clear: () => undefined },
      log: () => undefined,
    });
    const txid = 'ab'.repeat(32);
    const done = wa.arm([txid]);
    expect((await wa.beforeBroadcast([txid])).how).toBe('unbacked');
    done();
    expect(wa.count()).toBe(1);
    expect(await wa.retryNow()).toBe(false); // still held out: stays flagged
    const { w } = init(x, {}, { flushUnbacked: () => wa.retryNow() });
    expect(await w.ensureOurBackup()).toBe(true);
    await until(() => wa.count() === 0);
    expect(wa.count()).toBe(0);
  });

  test("(5) the repair fails three times running: the refusal says it couldn't be rebuilt and when next; b hears once", async () => {
    const x = await setup(2);
    const clock = { t: Date.now() };
    const reports: string[] = [];
    const { w } = init(
      x,
      {},
      {
        fill: async () => Promise.reject(new Error('WalletStorageClient rpcCall: network error 503')),
        now: () => clock.t,
        report: (t) => void reports.push(t),
      },
    );
    for (let i = 1; i <= 4; i++) {
      expect(w.heldOutRefusal(false)).toBe(
        i <= 3 ? OUR_BACKUP_REBUILDING_REFUSAL : ourBackupFailedRefusal(w.ourBackup().retryAt!, clock.t),
      );
      expect(await w.ensureOurBackup()).toBe(false);
      clock.t = w.ourBackup().retryAt! - 60_000; // a minute before the next try: the refusal names it
      if (i === 3) {
        expect(w.heldOutRefusal(false)).toMatch(/^Your backup couldn't be rebuilt\. It will try again at \d\d:\d\d\.$/);
        // Another backup connected in this session: the payment goes on.
        expect(w.heldOutRefusal(true)).toBeUndefined();
      }
      clock.t = w.ourBackup().retryAt!;
    }
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('could not be rebuilt after 3 tries');
    expect(reports[0]).toContain('WalletStorageClient rpcCall: network error 503');
    expect(serverIn(x)).toBe(false);
  });

  test('flag off: nothing to do, nothing filled, nothing joined', async () => {
    const x = await setup(1);
    const { w, log } = init(x, {}, { on: false });
    expect(await w.ensureOurBackup()).toBe(true);
    expect([log.fills.length, log.attached]).toEqual([0, 0]);
    expect(w.heldOut()).toBe(false);
  });
});
