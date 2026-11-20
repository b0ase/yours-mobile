/**
 * The first fill of a new backup (services/backupFill.ts; review of the instant restore, finding 4): the whole wallet
 * reaches the backup without the storage locks held for it, nothing a payment changes meanwhile is lost, and the
 * ordinary push afterwards starts from the backup's cursor. Real toolbox stores on fake-indexeddb; random keys.
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { Beef, KeyDeriver, MerklePath, P2PKH, PrivateKey, Random, Transaction, Utils } from '@bsv/sdk';
import { StorageIdb, StorageProvider, Wallet, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import { fillBackup, type FillManager } from './backupFill';

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
  const db = `fill-${name}-${++seq}-${Date.now()}`;
  (s as unknown as { dbName: string }).dbName = db;
  await s.migrate(db, `sik-${db}`);
  await s.makeAvailable();
  s.setServices(services);
  return s;
};

let height = 950_000;
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

/** A device with `n` coins, and an empty backup whose user row names the device (as addOurBackup leaves it). */
async function setup(n: number) {
  const kd = new KeyDeriver(PrivateKey.fromRandom());
  const dev = await store('dev');
  const backup = await store('backup');
  const sm = new WalletStorageManager(kd.identityKey, dev);
  await sm.makeAvailable();
  sm.setServices(services);
  const wallet = new Wallet({ chain: 'main', keyDeriver: kd, storage: sm, services } as never);
  for (let i = 0; i < n; i++) await receive(wallet, kd, 1000 + i);
  const { user } = await backup.findOrInsertUser(kd.identityKey);
  await backup.setActive(
    { identityKey: kd.identityKey, userId: user.userId } as never,
    dev.getSettings().storageIdentityKey,
  );
  const locks = { held: false, count: 0 };
  const manager = sm as unknown as FillManager;
  const real = manager.runAsSync.bind(sm);
  (manager as unknown as { runAsSync: unknown }).runAsSync = async (
    fn: (a: unknown) => Promise<unknown>,
    ...rest: unknown[]
  ) =>
    (real as (...a: unknown[]) => Promise<unknown>)(
      async (a: unknown) => {
        const outer = !locks.held;
        if (outer) locks.count++;
        locks.held = true;
        try {
          return await fn(a);
        } finally {
          if (outer) locks.held = false;
        }
      },
      ...rest,
    );
  return { kd, dev, backup, sm, wallet, manager, locks };
}

const rows = async (s: StorageIdb) => ({
  outputs: (await s.findOutputs({ partial: {} })).map((o) => `${o.txid}.${o.vout}:${o.spendable}`).sort(),
  transactions: (await s.findTransactions({ partial: {} })).map((t) => `${t.txid}:${t.status}`).sort(),
});

describe('first fill of a new backup', () => {
  test('two passes: the bulk without the locks, then only what changed meanwhile inside them', async () => {
    const x = await setup(12);
    const lockedDuringBulk: boolean[] = [];
    const r = await fillBackup({
      manager: x.manager,
      reader: x.dev,
      writer: x.backup,
      maxItems: 5,
      afterPage: async () => void lockedDuringBulk.push(x.locks.held),
    });
    expect(r.how).toBe('full');
    expect(r.unlockedPages).toBeGreaterThan(3);
    expect(lockedDuringBulk.every((h) => h === false)).toBe(true);
    expect(x.locks.count).toBe(1);
    expect(await rows(x.backup)).toEqual(await rows(x.dev));
    // The ordinary push carries on from the backup's cursor: nothing to send.
    const sm2 = x.sm;
    await sm2.addWalletStorageProvider(x.backup);
    const before = await rows(x.backup);
    await sm2.updateBackups();
    expect(await rows(x.backup)).toEqual(before);
  });

  test('a payment’s writes during the bulk pass are not lost (a row already sent changes, a new one arrives)', async () => {
    const x = await setup(10);
    let n = 0;
    await fillBackup({
      manager: x.manager,
      reader: x.dev,
      writer: x.backup,
      maxItems: 3,
      afterPage: async () => {
        // Once the backup holds a coin: that coin is spent here, and new rows are made.
        const sent = await x.backup.findOutputs({ partial: {} });
        if (n || !sent.length) return;
        n++;
        const [first] = await x.dev.findOutputs({ partial: { txid: sent[0].txid, vout: sent[0].vout } });
        await x.dev.updateOutput(first.outputId, { spendable: false });
        await receive(x.wallet, x.kd, 7777);
      },
    });
    expect(n).toBe(1);
    expect(await rows(x.backup)).toEqual(await rows(x.dev));
  });

  test('a device restored from our snapshot starts at the restore point: older rows are not sent again', async () => {
    const x = await setup(6);
    await new Promise((r) => setTimeout(r, 20));
    const restorePoint = new Date();
    await new Promise((r) => setTimeout(r, 20));
    const fresh = await receive(x.wallet, x.kd, 4242);
    const r = await fillBackup({ manager: x.manager, reader: x.dev, writer: x.backup, restorePoint, marginMs: 0 });
    expect(r.how).toBe('restore-point');
    expect(r.lockedMs).toHaveLength(1);
    expect((await x.backup.findTransactions({ partial: {} })).map((t) => t.txid)).toEqual([fresh]);
  });

  test('nothing new since the restore point: the two-pass fill instead (never a from-the-start push in the locks)', async () => {
    const x = await setup(4);
    const r = await fillBackup({
      manager: x.manager,
      reader: x.dev,
      writer: x.backup,
      restorePoint: new Date(Date.now() + 60_000),
      marginMs: 0,
    });
    expect(r.how).toBe('full');
    expect(await rows(x.backup)).toEqual(await rows(x.dev));
  });

  test('a backup that already has a cursor for this device: not needed', async () => {
    const x = await setup(3);
    await fillBackup({ manager: x.manager, reader: x.dev, writer: x.backup });
    expect((await fillBackup({ manager: x.manager, reader: x.dev, writer: x.backup })).how).toBe('not-needed');
  });
});
