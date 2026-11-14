/**
 * P0, 5 Nov 2026: the owner's 1p test on his iPhone (candidate c49da7b0, /bsv-wallet) failed with WERR_NOT_ACTIVE
 * ("WalletStorageManager is not accessing user's active storage or there are conflicting active stores configured"),
 * shown as "can't confirm whether it went out". The phone's own store named itself active; the backup's user row named
 * another store.
 *
 * Real wallet-toolbox (StorageIdb on fake-indexeddb, WalletStorageManager, Wallet) and the real @1sat/wallet factory
 * (createWalletCore: its 5 s connect race and its open-time setActive). The backup (wallet.1sat.app) is a StorageIdb
 * behind a stand-in StorageClient: not a StorageProvider, its own endpointUrl, a connect that can be slow, calls that
 * can fail. The broadcaster is a mock chain that refuses a coin spent twice. No network, random keys.
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { Beef, KeyDeriver, MerklePath, P2PKH, PrivateKey, Random, Transaction, Utils } from '@bsv/sdk';
import { Services, StorageIdb, StorageProvider, Wallet, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import { createWalletCore } from '@1sat/wallet';
import { forceLegacyActionBatch } from '../services/actionBatchMode';
import { armCoinPreflight, installCoinPreflightForWallet } from '../services/coinPreflight';
import {
  ensureBackupConnected,
  keepDeviceStoreActive,
  switchActiveAs,
  type KeepDeviceActiveDeps,
} from '../services/deviceActive';
import { createDeviceSync } from '../services/deviceSync';
import * as IS from '../services/inboundSync';
import { classifySendError } from '../utils/sendErrors';
import { captureConsole } from '../testing/captureConsole';

const HEIGHT = 971_004;
const REMOTE = 'https://wallet.1sat.test';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const holds = (cond: () => boolean) => {
  try {
    return cond();
  } catch {
    return false; // the manager is re-reading its stores
  }
};
const until = async (cond: () => boolean, ms = 5_000) => {
  for (const end = Date.now() + ms; !holds(cond); ) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(10);
  }
};

type Chain = {
  posts: string[];
  refused: string[];
  spentBy: Map<string, string>;
  known: Set<string>;
  raw: Map<string, number[]>;
};
const newChain = (): Chain => ({ posts: [], refused: [], spentBy: new Map(), known: new Set(), raw: new Map() });
const inputsOf = (tx: Transaction) =>
  tx.inputs.map((i) => `${i.sourceTXID ?? i.sourceTransaction?.id('hex')}.${i.sourceOutputIndex}`);

function services(chain: Chain) {
  const svc: Record<string, unknown> = {
    chain: 'main',
    getChainTracker: async () => ({ isValidRootForHeight: async () => true, currentHeight: async () => HEIGHT + 1 }),
    getHeight: async () => HEIGHT + 1,
    getHeaderForHeight: async () => new Array(80).fill(0),
    nLockTimeIsFinal: async () => true,
    hashOutputScript: (s: string) => s,
    getStatusForTxids: async (txids: string[]) => ({
      status: 'success',
      results: txids.map((txid) => ({ txid, status: chain.known.has(txid) ? 'known' : 'unknown', depth: 0 })),
    }),
    getMerklePath: async () => ({ name: 'mock', notes: [] }),
    getRawTx: async (txid: string) => ({ txid, name: 'mock', rawTx: chain.raw.get(txid) }),
    // The 1Sat spend index (the pre-sign coin check's first source): "txid_vout" -> spender.
    txo: { getSpends: async (ops: string[]) => ops.map((o) => chain.spentBy.get(o.replace('_', '.')) ?? null) },
    postBeef: async (beef: Beef, txids: string[]) => {
      for (const t of txids) {
        const tx = beef.findTxid(t)?.tx;
        if (!tx) continue;
        const clash = inputsOf(tx).find((o) => chain.spentBy.has(o) && chain.spentBy.get(o) !== t);
        if (clash) {
          chain.refused.push(t);
          const reason = `UTXO_SPENT: utxo already spent by tx ${chain.spentBy.get(clash)}`;
          return [
            {
              name: 'mock',
              status: 'error',
              error: new Error(reason),
              txidResults: [{ txid: t, status: 'error', data: { txStatus: 'REJECTED', extraInfo: reason } }],
            },
          ];
        }
      }
      for (const t of txids) {
        const tx = beef.findTxid(t)?.tx;
        if (!tx) continue;
        for (const o of inputsOf(tx)) chain.spentBy.set(o, t);
        chain.known.add(t);
        chain.raw.set(t, tx.toBinary());
        if (!chain.posts.includes(t)) chain.posts.push(t);
      }
      return [{ name: 'mock', status: 'success', txidResults: txids.map((txid) => ({ txid, status: 'success' })) }];
    },
  };
  return new Proxy(svc, {
    get: (t, p) =>
      p in t || typeof p === 'symbol' || p === 'then'
        ? t[p as string]
        : async () => {
            throw new Error(`mock services: ${String(p)}`);
          },
  }) as never;
}

/** WhatsOnChain /spent over the mock chain (the pre-sign coin check's second source). */
const wocFetch = (chain: Chain) =>
  (async (url: string) => {
    const sp = /\/tx\/([0-9a-f]{64})\/(\d+)\/spent$/.exec(String(url));
    const by = sp ? chain.spentBy.get(`${sp[1]}.${sp[2]}`) : undefined;
    return by
      ? new Response(JSON.stringify({ txid: by, vin: 0, status: 'unconfirmed' }), { status: 200 })
      : new Response('', { status: 404 });
  }) as unknown as typeof fetch;

let dbn = 0;
async function idb(name: string, sik: string, svc: never) {
  const s = new StorageIdb(StorageProvider.createStorageBaseOptions('main'));
  (s as unknown as { dbName: string }).dbName = name;
  await s.migrate(name, sik);
  await s.makeAvailable();
  s.setServices(svc);
  return s;
}

/** wallet.1sat.app: one store; every device connects to it with its own client. */
type Server = { store: StorageIdb; sik: string; connectMs: number; down: boolean; hang?: Promise<void> };
async function server(svc: never): Promise<Server> {
  const name = `notactive-remote-${++dbn}`; // its own names: fake-indexeddb is shared across files
  const sik = `1sat-cli-${name}`;
  return { store: await idb(name, sik, svc), sik, connectMs: 0, down: false };
}

/**
 * One connection, as the toolbox's StorageClient is: not a StorageProvider, `endpointUrl`, the connect handshake in
 * makeAvailable (slowed by `connectMs`; its settings cached after the first answer, as StorageClientBase does, so a later
 * makeAvailable makes no request even while the backup is down: review 19, F1), every other call answered by the
 * server's store (failing while `down`, waiting on `hang` for sync reads). Its own properties (the factory's 507
 * wrapper, the heal's deadlines) stay on the connection.
 */
function connect(srv: Server) {
  class StorageClient {}
  const own: Record<PropertyKey, unknown> = {};
  const local = new Set(['getSettings', 'isAvailable', 'setServices', 'getServices']);
  return new Proxy(own, {
    get(_, p) {
      if (p in own) return own[p];
      if (p === 'then') return undefined;
      if (p === 'constructor') return StorageClient;
      if (p === 'endpointUrl') return REMOTE;
      if (p === 'isStorageProvider') return () => false;
      if (p === 'destroy') return async () => undefined;
      if (p === 'makeAvailable')
        return async () => {
          // As the real StorageClientBase: the settings are cached after the first answer (no request after that).
          if (own.__settings) return own.__settings;
          if (srv.connectMs) await sleep(srv.connectMs);
          if (srv.down) throw new Error('network: wallet.1sat.test did not answer');
          return (own.__settings = await srv.store.makeAvailable());
        };
      const v = (srv.store as unknown as Record<PropertyKey, unknown>)[p];
      if (typeof v !== 'function') return v;
      return (...a: unknown[]) => {
        if (local.has(String(p))) return (v as (...x: unknown[]) => unknown).apply(srv.store, a);
        if (srv.down) return Promise.reject(new Error(`network: ${String(p)} failed`));
        if (p === 'getSyncChunk' && srv.hang)
          return srv.hang.then(() => (v as (...x: unknown[]) => unknown).apply(srv.store, a));
        return (v as (...x: unknown[]) => unknown).apply(srv.store, a);
      };
    },
    set(_, p, v) {
      own[p] = v;
      return true;
    },
  });
}

type Device = { db: string; sik: string };
const newDevice = (name: string): Device => {
  const db = `notactive-${name}-${++dbn}`; // its own names: fake-indexeddb is shared across files
  return { db, sik: `yours-${db}` };
};

/**
 * Open the wallet on a device the way createWebWallet does: this device's store first, then the backup (or the remote
 * as the active store, as 5.2.49 left the owner's Chrome extension). A new StorageIdb on the device's database = an
 * app restart.
 */
async function open(
  root: PrivateKey,
  dev: Device,
  srv: Server,
  svc: never,
  o: { remoteActive?: boolean; connectionTimeout?: number; unchecked?: boolean } = {},
) {
  const local = await idb(dev.db, dev.sik, svc);
  if (o.unchecked) IS._mergeUnchecked(local);
  class FakeStorageClient {
    constructor() {
      return connect(srv);
    }
  }
  const timeout = o.connectionTimeout ?? 2_000;
  // The factory (@1sat/wallet createWalletCore) races each backup's connect against connectionTimeout. A backup that
  // misses it (these tests slow it on purpose) or is down is skipped with ONE console.warn and the wallet opens on
  // this device's store; it is not an error. Assert exactly that warning when the backup is slow or down, and no
  // console output at all otherwise.
  const { result: core, logs } = await captureConsole(() =>
    createWalletCore(
      {
        privateKey: root.toWif(),
        chain: 'main',
        ...(o.remoteActive ? { activeRemote: REMOTE, backups: [] } : { backups: [REMOTE] }),
        connectionTimeout: timeout,
      } as never,
      local,
      { Services, StorageClient: FakeStorageClient, StorageProvider, Wallet, WalletStorageManager } as never,
    ),
  );
  expect(logs.error).toEqual([]);
  const backupMissed = !o.remoteActive && (srv.down || srv.connectMs >= timeout);
  expect(logs.warn).toHaveLength(backupMissed ? 1 : 0);
  if (backupMissed) {
    expect(logs.warn[0][0]).toBe(`[wallet-core] backup unreachable, skipped: ${REMOTE}`);
    expect((logs.warn[0][1] as Error).message).toBe(
      srv.down ? 'network: wallet.1sat.test did not answer' : `Remote storage connection timeout: ${REMOTE}`,
    );
  }
  core.storage.setServices(svc);
  (core.wallet as unknown as { services: unknown }).services = svc;
  expect(forceLegacyActionBatch(core.wallet)).toBe(true);
  return { core, local, storage: core.storage, wallet: core.wallet as unknown as Wallet };
}
type Open = Awaited<ReturnType<typeof open>>;

/** The fix exactly as initWallet installs it, right after the factory returns. */
type FixOptions = Omit<Partial<KeepDeviceActiveDeps>, 'setDeviceActive'>;
const withFix = (d: Open, o: FixOptions = {}) =>
  keepDeviceStoreActive(d.storage, {
    deviceIntended: () => true,
    setDeviceActive: () => d.core.setActiveStorage('local'),
    log: () => undefined,
    ...o,
  })!;

/** Which store the backup's user row names as the account's active store. */
const backupNames = async (srv: Server, identityKey: string) =>
  (await srv.store.findUsers({ partial: { identityKey } }))[0]?.activeStorage;

/** A mined BRC-29 receipt (as paymail delivers one) into this device. */
async function receive(w: Wallet, kd: KeyDeriver, sats: number) {
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
  tx.merklePath = new MerklePath(HEIGHT, [[{ offset: 0, hash: txid, txid: true }]]);
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
    description: 'Paymail payment',
  });
  return `${txid}.0`;
}

/** A plain payment, broadcast at once (the Store's 1p theme, or a Send). */
async function pay(w: Wallet, sats = 1_000) {
  const r = await w.createAction({
    description: 'Store theme',
    outputs: [
      {
        lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex(),
        satoshis: sats,
        outputDescription: 'theme',
      },
    ],
    options: { acceptDelayedBroadcast: false },
  });
  return { txid: r.txid!, inputs: inputsOf(Transaction.fromAtomicBEEF(r.tx as number[])) };
}

/** The coins a store would pay from (spendable change). */
const spendable = async (s: StorageIdb) =>
  (await s.findOutputs({ partial: {} })).filter((o) => o.spendable && o.change).map((o) => `${o.txid}.${o.vout}`);

const errOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as Error & { code?: string },
  );

/** Setup shared by the scenarios: the phone (this release) holds two coins and has pushed them to the backup. */
async function phoneWithCoins() {
  const chain = newChain();
  const svc = services(chain);
  const root = PrivateKey.fromRandom();
  const kd = new KeyDeriver(root);
  const srv = await server(svc);
  const phone = newDevice('phone');
  const p = await open(root, phone, srv, svc);
  const coins = [await receive(p.wallet, kd, 5_000), await receive(p.wallet, kd, 6_000)];
  await p.storage.updateBackups();
  expect(await backupNames(srv, kd.identityKey)).toBe(phone.sik);
  await p.wallet.destroy();
  return { chain, svc, root, kd, srv, phone, coins };
}

/** The phone reopens while the backup's connect is slower than the factory's limit, and that connect lands late. */
async function reopenWithSlowBackup(s: Awaited<ReturnType<typeof phoneWithCoins>>, fix = false) {
  s.srv.connectMs = 60;
  const p = await open(s.root, s.phone, s.srv, s.svc, { connectionTimeout: 30 });
  const keep = fix ? withFix(p) : undefined;
  // The factory gave up on the backup and opened with this device alone, which it found enabled.
  expect(p.storage.getAllStores()).toEqual([s.phone.sik]);
  // The connect it raced keeps going, and joins the stores when it lands.
  await until(() => p.storage.getAllStores().length === 2 && (!keep || !keep.needsHeal()));
  s.srv.connectMs = 0;
  return { p, keep };
}

describe('diagnosis (the toolbox and factory as shipped, no fix)', () => {
  test('(a) the 5.2.49 extension points the backup at the remote; the phone reopens with a late backup connect: every payment is refused before anything is built', async () => {
    const s = await phoneWithCoins();
    // The owner's Chrome extension on 5.2.49, remote-active: its factory makes the remote the account's active store.
    const ext = await open(s.root, newDevice('extension'), s.srv, s.svc, { remoteActive: true });
    expect(await backupNames(s.srv, s.kd.identityKey)).toBe(s.srv.sik);
    await ext.wallet.destroy();

    const { p } = await reopenWithSlowBackup(s);
    // The late store re-partitions: the backup names another store, so it is a "conflicting active".
    expect(p.storage.getConflictingStores()).toEqual([s.srv.sik]);
    expect(p.storage.isActiveEnabled).toBe(false);
    // What localFirst and ensureLocalForPayment check still says "this device": they let the payment through.
    expect(p.storage.isActiveStorageProvider()).toBe(true);
    expect(p.storage.getActiveUser().activeStorage).toBe(s.phone.sik); // the phone's own row names itself
    const before = (await p.local.findTransactions({ partial: {} })).length;

    const e = await errOf(pay(p.wallet));
    expect(e?.name).toBe('WERR_NOT_ACTIVE');
    expect(e?.message).toMatch(/not accessing user's active storage or there are conflicting active stores/);
    expect(e?.stack ?? '').toMatch(/getAuth[\s\S]*createAction/); // the owner's stack: refused at the first step
    expect((await p.local.findTransactions({ partial: {} })).length).toBe(before); // nothing built
    expect(s.chain.posts).toEqual([]); // nothing broadcast
    // Shown to the owner as "can't confirm" (the bug in the message).
    expect(classifySendError(e)).toMatchObject({ kind: 'unknown', moneyMoved: 'unknown' });
    // Receiving and the backup push are refused the same way, and the pull finds no backup.
    expect((await errOf(p.storage.updateBackups()))?.name).toBe('WERR_NOT_ACTIVE');
    expect(p.storage.getBackupStores()).toEqual([]);
    // In this session nothing makes the device active again: the factory's addRemote finds a connection (the late
    // one is not in its list, so it makes another), and only a connect inside the limit runs its setActive.
    s.srv.connectMs = 60;
    await errOf(p.core.addRemote(REMOTE));
    await until(() => p.storage.getAllStores().length === 3);
    expect(p.storage.isActiveEnabled).toBe(false);
    s.srv.connectMs = 0;
    await p.wallet.destroy();

    // Persistence: an open whose backup connects in time heals it (the factory's open-time setActive), until the
    // extension opens again and the next late connect.
    const q = await open(s.root, s.phone, s.srv, s.svc);
    expect(q.storage.isActiveEnabled).toBe(true);
    expect(await backupNames(s.srv, s.kd.identityKey)).toBe(s.phone.sik);
    expect(s.chain.posts).toEqual([]);
    await q.wallet.destroy();
  });

  test('(a) in session: the extension re-pointing the backup does not touch an open phone (rows are held in memory)', async () => {
    const s = await phoneWithCoins();
    const p = await open(s.root, s.phone, s.srv, s.svc);
    const ext = await open(s.root, newDevice('extension'), s.srv, s.svc, { remoteActive: true });
    expect(await backupNames(s.srv, s.kd.identityKey)).toBe(s.srv.sik);
    expect(p.storage.isActiveEnabled).toBe(true);
    const r = await pay(p.wallet);
    expect(s.chain.posts).toEqual([r.txid]);
    await p.storage.updateBackups(); // the push does not move the pointer back (its user row is older)
    expect(await backupNames(s.srv, s.kd.identityKey)).toBe(s.srv.sik);
    await ext.wallet.destroy();
    await p.wallet.destroy();
  });

  test('(b) two devices on this release: each open points the backup at itself; the same late connect refuses payments', async () => {
    const s = await phoneWithCoins();
    const tablet = newDevice('tablet');
    const t = await open(s.root, tablet, s.srv, s.svc);
    expect(await backupNames(s.srv, s.kd.identityKey)).toBe(tablet.sik);
    await t.wallet.destroy();
    const { p } = await reopenWithSlowBackup(s);
    expect(p.storage.getConflictingStores()).toEqual([s.srv.sik]);
    expect((await errOf(pay(p.wallet)))?.name).toBe('WERR_NOT_ACTIVE');
    await p.wallet.destroy();
  });

  test('(c) a Pay tap during the move to this device waits for the switch; it is never refused as not active', async () => {
    const s = await phoneWithCoins();
    const p = await open(s.root, s.phone, s.srv, s.svc, { remoteActive: true }); // an account still on the remote
    expect(p.storage.isActiveStorageProvider()).toBe(false);
    const move = p.core.setActiveStorage('local');
    const r = await pay(p.wallet);
    await move;
    expect(s.chain.posts).toEqual([r.txid]);
    expect(p.storage.isActiveEnabled).toBe(true);
    await p.wallet.destroy();
  });

  test("(d) a pull (syncFromReader) never imports the backup's choice of active store", async () => {
    const s = await phoneWithCoins();
    const p = await open(s.root, s.phone, s.srv, s.svc);
    const ext = await open(s.root, newDevice('extension'), s.srv, s.svc, { remoteActive: true });
    await p.storage.syncFromReader(s.kd.identityKey, connect(s.srv) as never);
    expect(p.storage.isActiveEnabled).toBe(true);
    expect((await p.local.findUsers({ partial: { identityKey: s.kd.identityKey } }))[0].activeStorage).toBe(
      s.phone.sik,
    );
    await pay(p.wallet);
    expect(s.chain.posts.length).toBe(1);
    await ext.wallet.destroy();
    await p.wallet.destroy();
  });
});

describe('the fix: this device stays the active store for its own payments', () => {
  test('the same sequence: the late backup is merged and this device made active again; the payment goes out, also after a restart', async () => {
    const s = await phoneWithCoins();
    const ext = await open(s.root, newDevice('extension'), s.srv, s.svc, { remoteActive: true });
    await ext.wallet.destroy();
    const { p, keep } = await reopenWithSlowBackup(s, true);
    // Healed as soon as the late connect landed: the backup is a backup again and names this device.
    expect(p.storage.isActiveEnabled).toBe(true);
    expect(p.storage.getConflictingStores()).toEqual([]);
    expect(p.storage.getBackupStores()).toEqual([s.srv.sik]);
    expect(await backupNames(s.srv, s.kd.identityKey)).toBe(s.phone.sik);
    const r = await pay(p.wallet);
    expect(s.chain.posts).toEqual([r.txid]);
    await p.storage.updateBackups(); // the device sync push works again
    keep!.stop();
    await p.wallet.destroy();

    // App restart, after the extension has opened again: the same, once more.
    const ext2 = await open(s.root, newDevice('extension'), s.srv, s.svc, { remoteActive: true });
    await ext2.wallet.destroy();
    const again = await reopenWithSlowBackup(s, true);
    const r2 = await pay(again.p.wallet);
    expect(s.chain.posts).toEqual([r.txid, r2.txid]);
    expect(s.chain.refused).toEqual([]);
    again.keep!.stop();
    await again.p.wallet.destroy();
  });

  test('a payment that starts before the heal waits for it and goes out (the heal runs first, then the build)', async () => {
    const s = await phoneWithCoins();
    const ext = await open(s.root, newDevice('extension'), s.srv, s.svc, { remoteActive: true });
    await ext.wallet.destroy();
    const { p } = await reopenWithSlowBackup(s); // conflicting, no fix yet
    expect(p.storage.isActiveEnabled).toBe(false);
    const keep = withFix(p); // installed on a manager already in the bad state (the late connect beat initWallet)
    const r = await pay(p.wallet);
    expect(s.chain.posts).toEqual([r.txid]);
    expect(p.storage.isActiveEnabled).toBe(true);
    keep.stop();
    await p.wallet.destroy();
  });

  test('two devices: each pays from its own store, never from the same coins; the heal merges the other device’s spend (through the inbound check)', async () => {
    const s = await phoneWithCoins();
    // The phone's store is checked like production (b-Aware A3); the backup and the tablet merge as they are.
    const unguard = IS.installInboundSyncGuard(StorageIdb);
    const stop = IS.registerInboundVerifier(s.phone.sik, s.kd.identityKey, {
      owns: IS.walletOwnership(s.root),
      readRecord: IS.walletRecords(s.root),
      spent: async () => ({ state: 'unclear' }),
      log: () => undefined,
    });
    IS._mergeUnchecked(s.srv.store);
    try {
      const tablet = newDevice('tablet');
      const t = await open(s.root, tablet, s.srv, s.svc, { unchecked: true });
      const fromTablet = await pay(t.wallet, 4_000);
      await t.storage.updateBackups();
      expect(fromTablet.inputs.length).toBe(1);

      const { p, keep } = await reopenWithSlowBackup(s, true);
      expect(p.storage.isActiveEnabled).toBe(true);
      // The tablet's spend came in with the merge: that coin is not spendable here.
      const spentHere = (await p.local.findOutputs({ partial: {} })).find(
        (o) => `${o.txid}.${o.vout}` === fromTablet.inputs[0],
      );
      expect(spentHere?.spendable).toBe(false);
      // The tablet's change is held for the chain (never spendable here on the backup's word alone).
      const tabletChange = (await p.local.findOutputs({ partial: { txid: fromTablet.txid } })).filter((o) => o.change);
      expect(tabletChange.length).toBeGreaterThan(0);
      expect(tabletChange.every((o) => !o.spendable)).toBe(true);

      const fromPhone = await pay(p.wallet, 4_000);
      expect(fromPhone.inputs.filter((i) => fromTablet.inputs.includes(i))).toEqual([]);
      expect(s.chain.posts).toEqual([fromTablet.txid, fromPhone.txid]);
      expect(s.chain.refused).toEqual([]);
      // The tablet's open session is untouched by the phone re-pointing the backup; its next pull takes the phone's
      // spend, so it won't pick that coin either.
      await p.storage.updateBackups();
      await t.storage.syncFromReader(s.kd.identityKey, connect(s.srv) as never);
      expect(t.storage.isActiveEnabled).toBe(true);
      expect((await spendable(t.local)).filter((c) => fromPhone.inputs.includes(c))).toEqual([]);
      keep!.stop();
      await p.wallet.destroy();
      await t.wallet.destroy();
    } finally {
      stop();
      unguard();
      IS._resetInboundVerifiers();
    }
  });

  test('the 5.2.49 extension keeps working: in its open session and after its next open, it never pays from the phone\u2019s coins', async () => {
    const s = await phoneWithCoins();
    const extDev = newDevice('extension');
    const ext0 = await open(s.root, extDev, s.srv, s.svc, { remoteActive: true }); // stays open throughout
    expect(ext0.storage.isActiveStorageProvider()).toBe(false);
    const { p, keep } = await reopenWithSlowBackup(s, true);
    expect(await backupNames(s.srv, s.kd.identityKey)).toBe(s.phone.sik);
    const fromPhone = await pay(p.wallet, 4_000);
    await p.storage.updateBackups(); // device sync's push (the Store pushes before it broadcasts)
    // Its open session still pays on the remote (createAction needs no active flag on the server), from the remote's
    // records, which hold the phone's spend.
    const fromExt0 = await pay(ext0.wallet, 1_000);
    expect(fromExt0.inputs.filter((i) => fromPhone.inputs.includes(i))).toEqual([]);
    await ext0.wallet.destroy();
    // Its next open points the backup at the remote again (as on every 5.2.49 open); the remote's records it pays from
    // hold every coin the phone and its own last session spent as spent.
    const ext1 = await open(s.root, extDev, s.srv, s.svc, { remoteActive: true });
    expect(await backupNames(s.srv, s.kd.identityKey)).toBe(s.srv.sik);
    expect(ext1.storage.isActiveEnabled).toBe(true);
    expect((await spendable(s.srv.store)).filter((c) => [...fromPhone.inputs, ...fromExt0.inputs].includes(c))).toEqual(
      [],
    );
    expect(s.chain.refused).toEqual([]);
    expect(s.chain.posts).toEqual([fromPhone.txid, fromExt0.txid]);
    // The phone's open session is not disturbed by that. It pays again with the pre-sign coin check installed over the
    // fix, as initWallet orders them: a coin the extension spent meanwhile is caught before signing and re-picked.
    // The check's own log (console.warn in the app) is recorded here: one plan caught and released, then the re-picked
    // plan checked clean, and nothing else.
    const checks: { m: string; d?: unknown }[] = [];
    expect(
      installCoinPreflightForWallet(p.storage, s.svc, {
        identityKey: s.kd.identityKey,
        fetch: wocFetch(s.chain),
        log: (m, d) => void checks.push({ m, d }),
      }),
    ).toBe(true);
    const scope = armCoinPreflight(true);
    const again = await pay(p.wallet, 500).finally(() => scope.done());
    expect(again.inputs.filter((i) => [...fromExt0.inputs, ...fromPhone.inputs].includes(i))).toEqual([]);
    expect(checks.map((c) => c.m.replace(/in \d+ ms/, 'in N ms'))).toEqual([
      '[coinPreflight] coins spent from another device; releasing this plan before signing',
      '[coinPreflight] 1 coin(s) checked in N ms: none spent elsewhere',
    ]);
    const caught = checks[0].d as { outpoint: string; spender: string; confirmed: boolean }[];
    expect(caught).toHaveLength(1);
    expect(fromExt0.inputs).toContain(caught[0].outpoint.replace('_', '.'));
    expect(caught[0].spender).toBe(fromExt0.txid);
    expect(s.chain.refused).toEqual([]);
    expect(s.chain.posts.at(-1)).toBe(again.txid);
    keep!.stop();
    await ext1.wallet.destroy();
    await p.wallet.destroy();
  });

  test('the backup drops during the heal: it is set aside, the payment goes out, and it reconnects and is healed by itself later', async () => {
    const s = await phoneWithCoins();
    const ext = await open(s.root, newDevice('extension'), s.srv, s.svc, { remoteActive: true });
    await ext.wallet.destroy();
    const { p } = await reopenWithSlowBackup(s); // conflicting
    s.srv.down = true;
    const keep = withFix(p, { retryMs: [100] });
    const r = await pay(p.wallet);
    expect(s.chain.posts).toEqual([r.txid]);
    expect(p.storage.getAllStores()).toEqual([s.phone.sik]); // the backup is out of this session for now
    expect(keep.paused().paused).toBe(true);
    s.srv.down = false;
    await until(() => !keep.paused().paused && p.storage.isActiveEnabled); // reconnected on its back-off, by itself
    expect(p.storage.isActiveEnabled).toBe(true);
    expect(p.storage.getBackupStores()).toEqual([s.srv.sik]);
    expect(await backupNames(s.srv, s.kd.identityKey)).toBe(s.phone.sik);
    keep.stop();
    await p.wallet.destroy();
  });

  test('a payment that still cannot start says plainly that nothing was sent (the toolbox refused it before building)', async () => {
    const s = await phoneWithCoins();
    const ext = await open(s.root, newDevice('extension'), s.srv, s.svc, { remoteActive: true });
    await ext.wallet.destroy();
    const { p } = await reopenWithSlowBackup(s);
    let release: () => void = () => undefined;
    s.srv.hang = new Promise<void>((r) => (release = r)); // the backup stops answering mid-merge
    const keep = withFix(p, { healWaitMs: 200 });
    const before = (await p.local.findTransactions({ partial: {} })).length;
    const e = await errOf(pay(p.wallet));
    expect(e?.message).toMatch(/Nothing was sent/);
    expect(e?.code).toBe('WERR_NOT_ACTIVE');
    expect(classifySendError(e)).toMatchObject({ moneyMoved: 'no' });
    expect(classifySendError(e).message).toMatch(/Nothing was sent\. Try again/);
    expect(s.chain.posts).toEqual([]);
    release();
    s.srv.hang = undefined;
    await until(() => p.storage.isActiveEnabled);
    expect((await p.local.findTransactions({ partial: {} })).length).toBe(before); // nothing was built
    // Try again: it goes out.
    const r = await pay(p.wallet);
    expect(s.chain.posts).toEqual([r.txid]);
    keep.stop();
    await p.wallet.destroy();
  });
});

/** Review 19 (c7ef7bde): its repros R1-R4 on the client that caches its settings, now asserting the fixed behaviour. */
describe('review 19: a backup that is down, hung, chosen, or registered twice', () => {
  /** The conflicting state after the extension's open and a late connect, then the backup goes down. */
  const conflictedThenDown = async () => {
    const s = await phoneWithCoins();
    const ext = await open(s.root, newDevice('extension'), s.srv, s.svc, { remoteActive: true });
    await ext.wallet.destroy();
    const { p } = await reopenWithSlowBackup(s);
    expect(p.storage.isActiveEnabled).toBe(false);
    return { s, p };
  };
  const readsAnswer = async (p: Open, ms = 1_500) =>
    Promise.race([
      Promise.all([p.wallet.listOutputs({ basket: 'default' } as never), p.storage.getAuth()]).then(() => 'answered'),
      sleep(ms).then(() => 'blocked'),
    ]);

  test('R1 (F1): device sync right after the backup was set aside, and later tries while it is still down, never wedge the wallet', async () => {
    const { s, p } = await conflictedThenDown();
    s.srv.down = true;
    const keep = withFix(p, { retryMs: [150, 150] });
    const first = await pay(p.wallet);
    expect(p.storage.getAllStores()).toEqual([s.phone.sik]);
    // initWallet's ensureBackup in the same device-sync run: no reconnect (before the fix it re-added the dead backup).
    const ensure = () => ensureBackupConnected({ storage: p.storage, keep, url: REMOTE, addRemote: p.core.addRemote });
    expect(await ensure()).toBe(false);
    expect(p.storage.getAllStores()).toEqual([s.phone.sik]);
    // Its back-off comes round while the backup is still down: the probe fails, nothing is added.
    await sleep(400);
    expect(keep.paused()).toMatchObject({ paused: true });
    expect(keep.paused().failures).toBeGreaterThanOrEqual(2);
    expect(await ensure()).toBe(false);
    expect(p.storage.isAvailable()).toBe(true);
    expect(p.storage.getAllStores()).toEqual([s.phone.sik]);
    expect(await readsAnswer(p)).toBe('answered');
    expect(p.storage.getBackupStores()).toEqual([]); // no throw inside ensureBackup either
    const second = await pay(p.wallet, 500);
    expect(s.chain.posts).toEqual([first.txid, second.txid]);
    // Back up: it reconnects by itself and is merged; device sync then finds it.
    s.srv.down = false;
    await until(() => !keep.paused().paused && p.storage.isActiveEnabled);
    expect(p.storage.getAllStores()).toEqual([s.phone.sik, s.srv.sik]);
    expect(await ensure()).toBe(true);
    expect(await backupNames(s.srv, s.kd.identityKey)).toBe(s.phone.sik);
    keep.stop();
    await p.wallet.destroy();
  });

  test('R1 through device sync (initWallet wiring): a sync while the backup is down fails softly, the next one after it is back pushes', async () => {
    const { s, p } = await conflictedThenDown();
    s.srv.down = true;
    const keep = withFix(p, { retryMs: [100] });
    const ds = createDeviceSync({
      applies: () => p.storage.isActiveStorageProvider(),
      ensureBackup: () => ensureBackupConnected({ storage: p.storage, keep, url: REMOTE, addRemote: p.core.addRemote }),
      pull: async () => {
        const reader = (p.storage as unknown as { _backups?: { storage: unknown }[] })._backups?.[0]?.storage;
        if (!reader) throw new Error('backup storage is not connected');
        await p.storage.syncFromReader(s.kd.identityKey, reader as never);
      },
      push: async () => {
        await p.storage.updateBackups();
      },
      log: () => undefined,
    });
    expect(await ds.syncNow()).toMatchObject({ ok: false });
    expect(await readsAnswer(p)).toBe('answered');
    const r = await pay(p.wallet);
    s.srv.down = false;
    await until(() => !keep.paused().paused);
    expect(await ds.syncNow()).toEqual({ ok: true, pulled: true, pushed: true });
    // The payment made while the backup was paused is on the backup now.
    expect((await s.srv.store.findTransactions({ partial: { txid: r.txid } })).length).toBe(1);
    keep.stop();
    await p.wallet.destroy();
  });

  test('R2: a backup-only row (random change built on the remote, and an aborted noSend: 877d2505’s shape) survives the heal and later pushes', async () => {
    const s = await phoneWithCoins();
    const unguard = IS.installInboundSyncGuard(StorageIdb);
    const stop = IS.registerInboundVerifier(s.phone.sik, s.kd.identityKey, {
      owns: IS.walletOwnership(s.root),
      readRecord: IS.walletRecords(s.root),
      spent: async () => ({ state: 'unclear' }),
      log: () => undefined,
    });
    IS._mergeUnchecked(s.srv.store);
    try {
      const ext = await open(s.root, newDevice('extension'), s.srv, s.svc, { remoteActive: true, unchecked: true });
      const done = await pay(ext.wallet, 1_000);
      const ns = (await ext.wallet.createAction({
        description: 'store nosend',
        outputs: [
          {
            lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex(),
            satoshis: 700,
            outputDescription: 'store theme',
          },
        ],
        options: { noSend: true, acceptDelayedBroadcast: false },
      } as never)) as { tx: number[] };
      const nsTxid = Transaction.fromAtomicBEEF(ns.tx).id('hex');
      const ref = ((await s.srv.store.findTransactions({ partial: { txid: nsTxid } }))[0] as { reference: string })
        .reference;
      await ext.wallet.abortAction({ reference: ref });
      await ext.wallet.destroy();
      const snap = async (txid: string) =>
        (await s.srv.store.findOutputs({ partial: { txid } })).map((o) => ({
          vout: o.vout,
          spendable: o.spendable,
          spentBy: o.spentBy,
          basketId: o.basketId,
          change: o.change,
          dp: o.derivationPrefix,
          ds: o.derivationSuffix,
          ci: o.customInstructions,
          sik: o.senderIdentityKey,
          u: new Date(o.updated_at as Date).getTime(),
        }));
      const before = { done: await snap(done.txid), ns: await snap(nsTxid) };
      expect(before.done.some((o) => o.change && o.dp && o.ds)).toBe(true);

      const { p, keep } = await reopenWithSlowBackup(s, true);
      expect(p.storage.isActiveEnabled).toBe(true);
      await p.storage.updateBackups();
      await pay(p.wallet, 300);
      await p.storage.updateBackups();
      expect({ done: await snap(done.txid), ns: await snap(nsTxid) }).toEqual(before);
      // The phone's copies keep the derivation pair (Find mined payments can rebuild from them).
      const copies = (await p.local.findOutputs({ partial: {} })).filter(
        (o) => (o.txid === done.txid || o.txid === nsTxid) && o.change,
      );
      expect(copies.length).toBeGreaterThan(0);
      expect(copies.every((o) => !!o.derivationPrefix && !!o.derivationSuffix)).toBe(true);
      keep!.stop();
      await p.wallet.destroy();
    } finally {
      stop();
      unguard();
      IS._resetInboundVerifiers();
    }
  });

  test('R3 (F2): a backup that hangs mid-merge holds the storage locks only until its deadline; reads, receipts and payments go on', async () => {
    const { s, p } = await conflictedThenDown();
    let release: () => void = () => undefined;
    s.srv.hang = new Promise<void>((r) => (release = r));
    const keep = withFix(p, { backupCallMs: 300, retryMs: [60_000] });
    await sleep(50); // the scheduled heal has started and holds the locks
    const t0 = Date.now();
    expect(await readsAnswer(p, 3_000)).toBe('answered');
    expect(Date.now() - t0).toBeLessThan(1_500);
    await until(() => keep.paused().paused); // the hung backup is set aside right after its merge fails
    const r = await pay(p.wallet);
    expect(s.chain.posts).toEqual([r.txid]);
    release();
    s.srv.hang = undefined;
    keep.stop();
    await p.wallet.destroy();
  });

  test('R4 (F3): a heal pending when Restore or Settings makes the remote active does not flip it back', async () => {
    const { s, p } = await conflictedThenDown();
    const keep = withFix(p); // schedules a heal
    const setActiveStorage = switchActiveAs(keep, p.core.setActiveStorage); // ctx.setActiveStorage, as initWallet
    await setActiveStorage(REMOTE);
    expect(p.storage.isActiveStorageProvider()).toBe(false);
    await sleep(300);
    expect(p.storage.isActiveStorageProvider()).toBe(false);
    expect(await backupNames(s.srv, s.kd.identityKey)).toBe(s.srv.sik);
    // The move back to this device (explicit) works, and heals apply again after it.
    await setActiveStorage('local');
    expect(p.storage.isActiveStorageProvider()).toBe(true);
    expect(p.storage.isActiveEnabled).toBe(true);
    keep.stop();
    await p.wallet.destroy();
  });

  test('F5: the same backup connected twice (the late connect and addRemote) is registered once', async () => {
    const { s, p } = await conflictedThenDown();
    await p.core.addRemote(REMOTE); // a second, prompt connection: its setActive heals, both stay registered
    expect(p.storage.getAllStores()).toEqual([s.phone.sik, s.srv.sik, s.srv.sik]);
    const keep = withFix(p);
    await until(() => p.storage.getAllStores().length === 2);
    expect(p.storage.getAllStores()).toEqual([s.phone.sik, s.srv.sik]);
    expect(p.storage.isActiveEnabled).toBe(true);
    await p.storage.updateBackups();
    keep.stop();
    await p.wallet.destroy();
  });
});
