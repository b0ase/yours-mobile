/**
 * INCIDENT (15 Oct 2026, dkg sweep 9f66943b…, second report): the sweep is mined and unspent (586.14198569 BSV to
 * 1HQ7kj7…), yet the wallet shows the old balance and "Find mined payments" says "Nothing to restore".
 *
 * Reproduced here: the device's store holds NO row for the sweep (restored/new device whose pull came up short, the
 * row only on the backup; or a row the 5.2.21 detectors can't see). Then the 5.2.21 repair finds nothing, and
 * "Recover a payment by transaction ID" restores it from the stored BRC-29 derivation, or honestly says it can't.
 *
 * Local only: fake-indexeddb, mocked chain and broadcaster, random keys. The real raw tx (public, read from
 * WhatsOnChain) is a fixture for the no-false-positive check.
 */
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { Beef, KeyDeriver, MerklePath, P2PKH, PrivateKey, Transaction, Utils } from '@bsv/sdk';
import {
  Monitor,
  StorageIdb,
  StorageProvider,
  Wallet,
  WalletStorageManager,
  defaultManagedChangePolicy,
} from '@bsv/wallet-toolbox-client';
import { sweepBsv } from '@1sat/actions';
import { OneSatServices } from '@1sat/client';
import { recoverMinedFailedActions, recoverySummary } from '../services/recoverFailed';
import { makeRecoverDeps, runRecoverOnce } from '../services/recoverFailedWiring';
import { fixUtxoStatus } from '../services/utxoStatus';
import { brc29Script, recoverPaymentByTxid, txidRecoverySummary } from '../services/recoverByTxid';
import { makeTxidRecoverDeps, sweepCandidateTxids } from '../services/recoverByTxidWiring';

/** The 9 inputs of 9f66943b… (sats), and the real output. */
const REAL_INPUTS = [
  6_014_198_708, 5_200_000_000, 5_900_000_000, 8_100_000_000, 9_000_000_000, 9_300_000_000, 6_300_000_000,
  8_700_000_000, 100_000_000,
];
const REAL_OUTPUT = 58_614_198_569;
const HEIGHT = 971004;

type PostMode = 'success' | 'doubleSpend' | 'successPlusDoubleSpend' | 'invalid' | 'serviceError' | 'hang';

/** The network, as the mocks see it. */
type Chain = {
  post: PostMode;
  /** txids with a merkle proof */
  mined: Set<string>;
  /** spent outpoints "txid.vout" -> spending txid */
  spent: Map<string, string>;
  /** the UTXO oracle: the shipped OneSatServices parser (bug B) or the fixed one */
  utxo: 'fixed' | 'shipped';
};

let dbn = 0;
/** Raw txs the mocked chain serves (getRawTx). */
const rawStore = new Map<string, number[]>();

const proofFor = (txid: string) => ({
  name: 'mock',
  merklePath: new MerklePath(HEIGHT, [[{ offset: 0, hash: txid, txid: true }]]),
  header: {
    version: 1,
    previousHash: '00'.repeat(32),
    merkleRoot: txid,
    time: 1760421413,
    bits: 0x1d00ffff,
    nonce: 0,
    height: HEIGHT,
    hash: '00'.repeat(32),
  },
});

/** 9 mined legacy coins at one address, like 12ECwr…: each its own parent tx with a one-leaf proof. */
function legacyCoins(key: PrivateKey) {
  const lockingScript = new P2PKH().lock(key.toAddress());
  const beef = new Beef();
  const inputs = REAL_INPUTS.map((sats, i) => {
    const parent = new Transaction();
    parent.addInput({
      sourceTXID: i.toString(16).padStart(64, '0'),
      sourceOutputIndex: 0,
      unlockingScript: lockingScript,
      sequence: 0xffffffff,
    });
    parent.addOutput({ lockingScript, satoshis: sats });
    const txid = parent.id('hex');
    parent.merklePath = new MerklePath(HEIGHT - 1 - i, [[{ offset: 0, hash: txid, txid: true }]]); // one block each: a one-leaf proof per height
    beef.mergeTransaction(parent);
    return { outpoint: `${txid}_0`, satoshis: sats, lockingScript: lockingScript.toHex() };
  });
  return { inputs, beef };
}

/** api.1sat.app /1sat/txo/<outpoint> as it answered on 14 Oct 2026: dot outpoint, no satoshis, "spend" when spent. */
const txoGet = (chain: Chain) => async (o: string) => {
  const [txid, vout] = o.split(/[._]/);
  if (!chain.mined.has(txid)) throw new Error('404 Not Found');
  const spend = chain.spent.get(`${txid}.${vout}`);
  return { outpoint: `${txid}.${vout}`, score: 0, ...(spend ? { spend } : {}) };
};

function makeServices(chain: Chain) {
  const chainTracker = { isValidRootForHeight: async () => true, currentHeight: async () => HEIGHT + 1 };
  const svc: Record<string, unknown> = {
    chain: 'main',
    txo: { get: txoGet(chain) },
    getChainTracker: async () => chainTracker,
    getHeight: async () => HEIGHT + 1,
    getBsvExchangeRate: async () => 50,
    getFiatExchangeRate: async () => 1,
    nLockTimeIsFinal: async () => true,
    getHeaderForHeight: async () => new Array(80).fill(0),
    hashOutputScript: (s: string) => s,
    getStatusForTxids: async (txids: string[]) => ({
      results: txids.map((txid) => ({ txid, status: chain.mined.has(txid) ? 'mined' : 'unknown', depth: 1 })),
    }),
    getRawTx: async (txid: string) => ({ txid, name: 'mock', rawTx: rawStore.get(txid) }),
    getMerklePath: async (txid: string) => (chain.mined.has(txid) ? proofFor(txid) : { name: 'mock', notes: [] }),
    postBeef: async (_beef: Beef, txids: string[]) => {
      if (chain.post === 'hang') return new Promise(() => undefined);
      const res = (name: string, r: Record<string, unknown>) => ({
        name,
        status: r.status,
        txidResults: txids.map((txid) => ({ txid, ...r })),
      });
      switch (chain.post) {
        case 'success':
          return [res('arc', { status: 'success' })];
        case 'doubleSpend':
          return [res('arc', { status: 'error', doubleSpend: true, competingTxs: [] })];
        case 'successPlusDoubleSpend':
          return [
            res('arc', { status: 'success' }),
            res('arc2', { status: 'error', doubleSpend: true, competingTxs: [] }),
          ];
        case 'invalid':
          return [res('arc', { status: 'error', data: { detail: 'rejected' } })];
        case 'serviceError':
          return [res('arc', { status: 'error', serviceError: true })];
      }
    },
  };
  if (chain.utxo === 'fixed') {
    expect(fixUtxoStatus(svc)).toBe(true); // what initWallet installs
  } else {
    const shipped = new OneSatServices('main', 'https://example.invalid');
    (shipped as unknown as { txo: unknown }).txo = svc.txo;
    svc.getUtxoStatus = (h: string, f: unknown, o: string) => shipped.getUtxoStatus(h, f as never, o);
  }
  return new Proxy(svc, {
    get(t, p) {
      if (p in t || typeof p === 'symbol' || p === 'then') return (t as Record<string | symbol, unknown>)[p];
      return async () => {
        throw new Error(`mock services: ${String(p)} not implemented`);
      };
    },
  });
}

async function openWallet(rootKey: PrivateKey, dbName: string, services: unknown, backupDb?: string) {
  const kd = new KeyDeriver(rootKey);
  const mk = async (name: string) => {
    const o = StorageProvider.createStorageBaseOptions('main');
    // wallet.1sat.app made the real sweep with a single change output; mirror that.
    o.managedChangePolicy = { ...defaultManagedChangePolicy(), maxOutputsPerAction: 1 };
    const s = new StorageIdb(o);
    (s as unknown as { dbName: string }).dbName = name; // StorageIdb names its DB per chain; one DB per "device"
    await s.migrate(name, PrivateKey.fromRandom().toPublicKey().toString());
    await s.makeAvailable();
    s.setServices(services as never);
    return s;
  };
  const active = await mk(dbName);
  const backups = backupDb ? [await mk(backupDb)] : [];
  const storage = new WalletStorageManager(kd.identityKey, active, backups);
  await storage.makeAvailable();
  if (backups.length) await storage.setActive(active.getSettings().storageIdentityKey);
  storage.setServices(services as never);
  const monitor = new Monitor({
    chain: 'main',
    services: services as never,
    storage,
    chaintracks: { isValidRootForHeight: async () => true, currentHeight: async () => HEIGHT + 1 } as never,
    msecsWaitPerMerkleProofServiceReq: 0,
    taskRunWaitMsecs: 0,
    abandonedMsecs: 300000,
    unprovenAttemptsLimitTest: 10,
    unprovenAttemptsLimitMain: 144,
    maxRebroadcastAttempts: 0,
  } as never);
  monitor.addDefaultTasks();
  const wallet = new Wallet({ chain: 'main', keyDeriver: kd, storage, services: services as never, monitor } as never);
  return { wallet, storage, monitor };
}
type W = Awaited<ReturnType<typeof openWallet>>;

/** Run the production recovery (initWallet.recoverFailed) on this wallet. */
const recover = (w: W, services: unknown) =>
  runRecoverOnce(() =>
    recoverMinedFailedActions({
      ...makeRecoverDeps({
        storage: w.storage,
        wallet: w.wallet,
        services: services as never,
        monitor: w.monitor as never,
      }),
      log: () => undefined,
    }),
  );

async function sweep(post: PostMode, opts: { backupDb?: string; utxo?: Chain['utxo'] } = {}) {
  const root = PrivateKey.fromRandom();
  const chain: Chain = { post, mined: new Set(), spent: new Map(), utxo: opts.utxo ?? 'fixed' };
  const services = makeServices(chain);
  const dbName = `unrecorded-${++dbn}`;
  const w = await openWallet(root, dbName, services, opts.backupDb);
  const legacy = PrivateKey.fromRandom();
  const coins = legacyCoins(legacy);
  for (const i of coins.inputs) chain.mined.add(i.outpoint.slice(0, 64));
  const ctx = { wallet: w.wallet, services: { getBeefForTxid: async () => Beef.fromBinary(coins.beef.toBinary()) } };
  const run = sweepBsv.execute(
    ctx as never,
    {
      inputs: coins.inputs,
      keys: coins.inputs.map(() => legacy),
    } as never,
  );
  const r = (
    post === 'hang'
      ? await Promise.race([run, new Promise<{ hung: true }>((ok) => setTimeout(() => ok({ hung: true }), 1500))])
      : await run
  ) as { txid?: string; error?: string; hung?: true };
  return { r, w, root, dbName, services, chain, inputs: coins.inputs };
}

/** Our tx's txid, whatever its status (listActions hides failed ones). */
const sweepTxid = async (w: W) =>
  w.storage.runAsStorageProvider(
    async (sp) => (await sp.findTransactions({ partial: {}, noRawTx: true }))[0]?.txid ?? '',
  );

/** The chain mines it: proof available, the 9 legacy inputs are spent by it. */
const mine = (chain: Chain, txid: string, inputs: { outpoint: string }[]) => {
  chain.mined.add(txid);
  for (const i of inputs) chain.spent.set(i.outpoint.replace('_', '.'), txid);
};

const balance = async (w: W) =>
  (await w.wallet.listOutputs({ basket: 'default', limit: 100 })).outputs.reduce((s, o) => s + o.satoshis, 0);
const spendableOutputs = async (w: W) =>
  (await w.wallet.listOutputs({ basket: 'default', limit: 100 })).outputs.filter((o) => o.spendable);
const statusOf = async (w: W, txid: string) =>
  w.storage.runAsStorageProvider(
    async (sp) => (await sp.findTransactions({ partial: { txid }, noRawTx: true }))[0]?.status,
  );

/** Production wiring of recoverByTxid on this wallet. */
const recoverTxid = (w: W, services: unknown, txid: string) =>
  recoverPaymentByTxid(
    txid,
    makeTxidRecoverDeps({
      storage: w.storage,
      wallet: w.wallet as never,
      services: services as never,
      log: () => undefined,
    }),
  );

/** The sweep's raw tx out of the device that made it, published to the mocked chain. */
async function publish(w: W, txid: string) {
  const raw = await w.storage.runAsStorageProvider(
    async (sp) =>
      (await sp.findTransactions({ partial: { txid } }))[0].rawTx ??
      (await sp.findProvenTxReqs({ partial: { txid } }))[0]?.rawTx,
  );
  rawStore.set(txid, Array.from(raw!));
}

/**
 * A second device for the same seed. With a backup (the first device's store): the toolbox copies it in on open, so
 * the sweep's rows are then removed from the device's own store: the short pull of the 14 Oct restore incident.
 */
async function secondDevice(root: PrivateKey, services: unknown, backupOf?: string, sweepTxid?: string) {
  const w = await openWallet(root, `unrecorded-dev2-${++dbn}`, services, backupOf);
  if (sweepTxid) {
    const idb = (
      w.storage as unknown as { _active: { storage: { db: { delete: (s: string, k: number) => Promise<void> } } } }
    )._active.storage.db;
    await w.storage.runAsStorageProvider(async (sp) => {
      for (const o of await sp.findOutputs({ partial: { txid: sweepTxid } })) await idb.delete('outputs', o.outputId);
      for (const t of await sp.findTransactions({ partial: { txid: sweepTxid }, noRawTx: true }))
        await idb.delete('transactions', t.transactionId);
      for (const q of await sp.findProvenTxReqs({ partial: { txid: sweepTxid } }))
        await idb.delete('proven_tx_reqs', q.provenTxReqId);
    });
  }
  return w;
}

const ownedSnapshot = async (w: W) =>
  w.storage.runAsStorageProvider(async (sp) => ({
    txs: (await sp.findTransactions({ partial: {}, noRawTx: true })).map((t) => [t.txid, t.status]),
    outs: (await sp.findOutputs({ partial: {} })).map((o) => [o.txid, o.vout, o.satoshis, o.spendable]),
  }));

describe('reproduced: sweep mined, its output not in the device store; 5.2.21 says "Nothing to restore"', () => {
  test('row only on the backup: Find mined payments finds nothing; Recover by txid restores 586.14198569 BSV', async () => {
    const { w: dev1, root, services, chain, inputs, dbName } = await sweep('success');
    const txid = await sweepTxid(dev1);
    mine(chain, txid, inputs);
    await publish(dev1, txid);
    const dev2 = await secondDevice(root, services, dbName, txid);
    expect(await balance(dev2)).toBe(0);
    // BEFORE: the shipped repair has nothing to look at.
    const rep = await recover(dev2, services);
    expect(recoverySummary(rep)).toBe('Nothing to restore');
    // AFTER: by txid, from the derivation the backup holds.
    const r = await recoverTxid(dev2, services, txid);
    console.log('[row on backup] before 0, after', await balance(dev2), '|', txidRecoverySummary(r));
    expect(r.result).toBe('restored');
    expect(r.restoredSats).toBe(REAL_OUTPUT);
    expect(await balance(dev2)).toBe(REAL_OUTPUT);
    expect((await spendableOutputs(dev2)).map((o) => o.outpoint)).toEqual([`${txid}.0`]);
    expect(await dev2.wallet.balance()).toBe(REAL_OUTPUT);
    // Idempotent.
    const before = await ownedSnapshot(dev2);
    const again = await recoverTxid(dev2, services, txid);
    expect(again.result).toBe('already');
    expect(txidRecoverySummary(again)).toMatch(/is in your wallet \(586\.14198569 BSV/);
    expect(await ownedSnapshot(dev2)).toEqual(before);
  }, 60000);

  test('no row anywhere (the derivation is gone): honest "nothing of yours", nothing changes', async () => {
    const { w: dev1, root, services, chain, inputs } = await sweep('success');
    const txid = await sweepTxid(dev1);
    mine(chain, txid, inputs);
    await publish(dev1, txid);
    const dev2 = await secondDevice(root, services);
    const before = await ownedSnapshot(dev2);
    expect(recoverySummary(await recover(dev2, services))).toBe('Nothing to restore');
    const r = await recoverTxid(dev2, services, txid);
    expect(r.result).toBe('not-ours');
    expect(txidRecoverySummary(r)).toMatch(/Nothing in .* belongs to this wallet/);
    expect(await ownedSnapshot(dev2)).toEqual(before);
    expect(await balance(dev2)).toBe(0);
  }, 60000);

  test('row present but its change marked spent by a failed action (invisible to hiddenChange): repaired', async () => {
    const { w, services, chain, inputs } = await sweep('success');
    const txid = await sweepTxid(w);
    mine(chain, txid, inputs);
    await publish(w, txid);
    await w.storage.runAsStorageProvider(async (sp) => {
      const [t] = await sp.findTransactions({ partial: { txid }, noRawTx: true });
      for (const o of await sp.findOutputs({ partial: { txid } }))
        await sp.updateOutput(o.outputId, { spendable: false, spentBy: t.transactionId });
    });
    expect(await balance(w)).toBe(0);
    expect(recoverySummary(await recover(w, services))).toBe('Nothing to restore');
    const r = await recoverTxid(w, services, txid);
    expect(r.result).toBe('restored');
    expect(await balance(w)).toBe(REAL_OUTPUT);
    expect(await statusOf(w, txid)).toBe('completed');
    expect((await recoverTxid(w, services, txid)).result).toBe('already');
  }, 60000);

  test('row still failed with no proven-tx request: repaired to completed, spendable', async () => {
    const { w, services, chain, inputs } = await sweep('invalid');
    const txid = await sweepTxid(w);
    mine(chain, txid, inputs);
    await publish(w, txid);
    await w.storage.runAsStorageProvider(async (sp) => {
      for (const q of await sp.findProvenTxReqs({ partial: { txid } }))
        await sp.updateProvenTxReq(q.provenTxReqId, { txid: 'ff'.repeat(32) });
    });
    const r = await recoverTxid(w, services, txid);
    expect(r.result).toBe('restored');
    expect(await statusOf(w, txid)).toBe('completed');
    expect(await balance(w)).toBe(REAL_OUTPUT);
  }, 60000);
});

describe('safety', () => {
  test('a spent output is not restored; an unclear chain answer changes nothing', async () => {
    const { w: dev1, root, services, chain, inputs, dbName } = await sweep('success');
    const txid = await sweepTxid(dev1);
    mine(chain, txid, inputs);
    await publish(dev1, txid);
    const dev2 = await secondDevice(root, services, dbName, txid);
    chain.spent.set(`${txid}.0`, 'ab'.repeat(32));
    const spent = await recoverTxid(dev2, services, txid);
    expect(spent.outputs[0]?.state, JSON.stringify(spent)).toBe('spent');
    chain.spent.delete(`${txid}.0`);
    chain.mined.delete(txid); // txo lookup 404 → inconclusive; and no proof
    expect((await recoverTxid(dev2, services, txid)).result).toBe('not-mined');
    expect(await balance(dev2)).toBe(0);
  }, 60000);

  test("someone else's sweep (another seed) is never added", async () => {
    const { w: other, services, chain, inputs } = await sweep('success');
    const txid = await sweepTxid(other);
    mine(chain, txid, inputs);
    await publish(other, txid);
    const mine2 = await openWallet(PrivateKey.fromRandom(), `unrecorded-other-${++dbn}`, services);
    // even with the other wallet's store attached, its pairs derive to other scripts under this identity key
    const r = await recoverTxid(mine2, services, txid);
    expect(r.result).toBe('not-ours');
    expect(await balance(mine2)).toBe(0);
  }, 60000);

  test("dkg's real tx (public raw, read-only fixture): parsed, 1 output of 586.14198569 BSV, not ours for a random wallet", async () => {
    const hex = readFileSync(new URL('./fixtures/dkg-sweep-9f66943b.hex', import.meta.url), 'utf8').trim();
    const tx = Transaction.fromHex(hex);
    const txid = tx.id('hex');
    expect(txid).toBe('9f66943be1ed8157b6935c5ae19b6508cbc4a17779a5e5f3f42bf7034a08309b');
    expect(tx.inputs.length).toBe(9);
    expect(tx.outputs.map((o) => o.satoshis)).toEqual([REAL_OUTPUT]);
    expect(tx.outputs[0].lockingScript.toHex()).toBe(new P2PKH().lock('1HQ7kj7WqzCCGFwgwVtwhVAngzGEXgRAWh').toHex());
    const chain: Chain = { post: 'success', mined: new Set([txid]), spent: new Map(), utxo: 'fixed' };
    const services = makeServices(chain);
    rawStore.set(txid, Array.from(Utils.toArray(hex, 'hex')));
    const w = await openWallet(PrivateKey.fromRandom(), `unrecorded-real-${++dbn}`, services);
    const r = await recoverTxid(w, services, txid);
    expect(r.result).toBe('not-ours');
    expect(await balance(w)).toBe(0);
  }, 60000);

  test('brc29Script matches the toolbox change lock (self counterparty)', async () => {
    const { w } = await sweep('success');
    const [o] = await w.storage.runAsStorageProvider((sp) => sp.findOutputs({ partial: { change: true } }));
    expect(brc29Script(w.wallet.keyDeriver as never, o as never)).toBe(Utils.toHex(o.lockingScript!));
  }, 60000);

  test('Find mined payments candidates: sweep rows by txid', async () => {
    const { w } = await sweep('success');
    const txid = await sweepTxid(w);
    expect(await sweepCandidateTxids(w.storage as never, undefined)).toEqual([txid]);
  }, 60000);
});

/**
 * Remote active (a restored account, wallet.1sat.app as active) and the copy to this device keeps failing. The remote
 * stand-in is a StorageIdb the manager treats as a remote (isStorageProvider false), like the toolbox's StorageClient.
 */
async function remoteActiveDevice(root: PrivateKey, services: unknown, remoteDb: string, sweepTxid: string) {
  const kd = new KeyDeriver(root);
  const mk = async (name: string, remote: boolean) => {
    const o = StorageProvider.createStorageBaseOptions('main');
    o.managedChangePolicy = { ...defaultManagedChangePolicy(), maxOutputsPerAction: 1 };
    const s = new StorageIdb(o);
    (s as unknown as { dbName: string }).dbName = name;
    await s.migrate(name, PrivateKey.fromRandom().toPublicKey().toString());
    await s.makeAvailable();
    s.setServices(services as never);
    if (remote) (s as unknown as { isStorageProvider: () => boolean }).isStorageProvider = () => false;
    return s;
  };
  const remote = await mk(remoteDb, true);
  const local = await mk(`unrecorded-dev-${++dbn}`, false);
  const storage = new WalletStorageManager(kd.identityKey, remote, [local]);
  await storage.makeAvailable();
  await storage.setActive(remote.getSettings().storageIdentityKey);
  storage.setServices(services as never);
  // The copy to this device failed: the sweep is not in the device store.
  const auth = { userId: (await local.findOrInsertUser(kd.identityKey)).user.userId, identityKey: kd.identityKey };
  const db = (local as unknown as { db: { delete: (s: string, k: number) => Promise<void> } }).db;
  for (const o of await local.findOutputs({ partial: { userId: auth.userId, txid: sweepTxid } }))
    await db.delete('outputs', o.outputId);
  for (const t of await local.findTransactions({ partial: { userId: auth.userId, txid: sweepTxid }, noRawTx: true }))
    await db.delete('transactions', t.transactionId);
  const wallet = new Wallet({ chain: 'main', keyDeriver: kd, storage, services: services as never } as never);
  return { wallet, storage, monitor: null } as unknown as W;
}

describe('remote active, copy to this device failing (owner to dkg, 15 Oct 2026)', () => {
  test('Find mined payments is skipped remote-active; by-txid repairs in the device store and syncs to the remote', async () => {
    const { w: dev1, root, services, chain, inputs, dbName } = await sweep('success');
    const txid = await sweepTxid(dev1);
    mine(chain, txid, inputs);
    await publish(dev1, txid);
    // dkg's state on the remote: History shows the sweep, its change is unspendable and marked spent (by itself).
    await dev1.storage.runAsStorageProvider(async (sp) => {
      const [t] = await sp.findTransactions({ partial: { txid }, noRawTx: true });
      for (const o of await sp.findOutputs({ partial: { txid } }))
        await sp.updateOutput(o.outputId, { spendable: false, spentBy: t.transactionId });
    });
    const w = await remoteActiveDevice(root, services, dbName, txid);
    expect(w.storage.isActiveStorageProvider()).toBe(false);
    expect(await balance(w)).toBe(0);
    const rep = await recover(w, services);
    expect(rep.skipped).toBe('active storage is remote'); // what 5.2.21/5.2.22 did here
    const r = await recoverTxid(w, services, txid);
    console.log('[remote active] before 0, after', await balance(w), '|', txidRecoverySummary(r));
    expect(r.result).toBe('restored');
    expect(await balance(w)).toBe(REAL_OUTPUT); // shown from the remote, once, not twice
    expect((await spendableOutputs(w)).map((o) => o.outpoint)).toEqual([`${txid}.0`]);
    const again = await recoverTxid(w, services, txid);
    expect(['already', 'restored']).toContain(again.result);
    expect(await balance(w)).toBe(REAL_OUTPUT);
  }, 60000);
});

describe('local active with an INCOMPLETE copy (sweep row only on wallet.1sat.app, hidden there)', () => {
  test('pulled from the backup by txid (merge only), restored on the device, pushed back; nothing deleted', async () => {
    const { w: dev1, root, services, chain, inputs, dbName } = await sweep('success');
    const txid = await sweepTxid(dev1);
    mine(chain, txid, inputs);
    await publish(dev1, txid);
    await dev1.storage.runAsStorageProvider(async (sp) => {
      const [t] = await sp.findTransactions({ partial: { txid }, noRawTx: true });
      for (const o of await sp.findOutputs({ partial: { txid } }))
        await sp.updateOutput(o.outputId, { spendable: false, spentBy: t.transactionId });
    });
    const dev2 = await secondDevice(root, services, dbName, txid);
    expect(dev2.storage.isActiveStorageProvider()).toBe(true);
    const backupRowsBefore = await dev1.storage.runAsStorageProvider(
      async (sp) => (await sp.findOutputs({ partial: {} })).length,
    );
    expect(recoverySummary(await recover(dev2, services))).toBe('Nothing to restore');
    const r = await recoverTxid(dev2, services, txid);
    expect(r.result).toBe('restored');
    expect(await balance(dev2)).toBe(REAL_OUTPUT);
    const backupRowsAfter = await dev1.storage.runAsStorageProvider(
      async (sp) => (await sp.findOutputs({ partial: {} })).length,
    );
    expect(backupRowsAfter).toBeGreaterThanOrEqual(backupRowsBefore);
    expect((await recoverTxid(dev2, services, txid)).result).toBe('already');
    expect(await balance(dev2)).toBe(REAL_OUTPUT);
  }, 60000);
});

describe('fast path (owner, 15 Oct 2026: d2be946f… already in the wallet showed "Checking…" forever)', () => {
  test('a payment in the wallet answers from local records in under 1 s with no network or remote calls', async () => {
    const { w, services } = await sweep('success');
    const txid = await sweepTxid(w);
    const offline = new Proxy(services as object, {
      get(t, p) {
        if (p === 'getRawTx' || p === 'getMerklePath' || p === 'getUtxoStatus')
          return async () => {
            throw new Error(`network called: ${String(p)}`);
          };
        return (t as Record<string | symbol, unknown>)[p];
      },
    });
    const t0 = Date.now();
    const r = await recoverTxid(w, offline, txid);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.result).toBe('already');
    expect(txidRecoverySummary(r)).toMatch(/^Checked: .* is in your wallet \(586\.14198569 BSV/);
  }, 60000);
});
