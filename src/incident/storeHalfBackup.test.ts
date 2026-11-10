/**
 * Review of f5c38ec1 (MINOR 6): a backup can half-work. The push lands on the backup, but the device gave up waiting
 * (60 s), so the Store payment counts as "not backed up" and is released here (abortAction: 'nosend' → 'failed', inputs
 * spendable again). The backup then holds the payment as 'nosend' with its inputs spent, the device holds it 'failed'
 * with its inputs free. The device's newer 'failed' must win both ways: a pull of the backup's older 'nosend' must not
 * lock the coin again here, and the next push must free it on the backup.
 *
 * Real StorageIdb x2 (device + backup), WalletStorageManager, the real inbound guard (as initWallet installs it),
 * toolbox syncFromReader (the device sync's pull) and updateBackups (its push). Random keys, mocked chain.
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Beef, KeyDeriver, MerklePath, P2PKH, PrivateKey, Random, Script, Transaction, Utils } from '@bsv/sdk';
import { StorageIdb, StorageProvider, Wallet, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import * as IS from '../services/inboundSync';
import { forceLegacyActionBatch } from '../services/actionBatchMode';

const HEIGHT = 974_800;
const services = new Proxy(
  {
    chain: 'main',
    getChainTracker: async () => ({ isValidRootForHeight: async () => true, currentHeight: async () => HEIGHT + 1 }),
    getHeight: async () => HEIGHT + 1,
    getHeaderForHeight: async () => new Array(80).fill(0),
    nLockTimeIsFinal: async () => true,
    hashOutputScript: (s: string) => s,
    // The payment never reached the network.
    getStatusForTxids: async (txids: string[]) => ({
      status: 'success',
      results: txids.map((txid) => ({ txid, status: 'unknown', depth: 0 })),
    }),
  } as Record<string, unknown>,
  {
    get: (t, p) =>
      p in t || typeof p === 'symbol' || p === 'then'
        ? t[p as string]
        : async () => {
            throw new Error(`mock ${String(p)}`);
          },
  },
) as never;
const store = async (name: string) => {
  const s = new StorageIdb(StorageProvider.createStorageBaseOptions('main'));
  (s as unknown as { dbName: string }).dbName = name;
  await s.migrate(name, `sik-${name}`);
  await s.makeAvailable();
  s.setServices(services);
  return s;
};
beforeAll(() => void IS.installInboundSyncGuard(StorageIdb));
afterAll(() => {
  IS._uninstallInboundSyncGuard(StorageIdb);
  IS._resetInboundVerifiers();
});

type Out = { txid?: string; vout: number; spendable: boolean; spentBy?: number; change: boolean; satoshis: number };
type Tx = { transactionId: number; txid?: string; status: string };
const txOf = async (s: StorageIdb, txid: string) =>
  ((await s.findTransactions({ partial: { txid } })) as unknown as Tx[])[0];
const coinOf = async (s: StorageIdb, txid: string, vout: number) =>
  ((await s.findOutputs({ partial: { txid, vout } } as never)) as unknown as Out[])[0];

test("a half-worked backup, then a local release: the device's newer 'failed' wins the pull and the next push", async () => {
  const root = PrivateKey.fromRandom();
  const kd = new KeyDeriver(root);
  const backup = await store('half-backup');
  IS._mergeUnchecked(backup);
  const device = await store('half-device');
  IS.registerInboundVerifier(device.getSettings().storageIdentityKey, kd.identityKey, {
    owns: IS.walletOwnership(root),
    spent: async () => ({ state: 'unspent' as const }),
    txKnown: async () => 'known' as const,
    readRecord: IS.walletRecords(root),
    log: () => undefined,
  });
  const sm = new WalletStorageManager(kd.identityKey, device, [backup]);
  await sm.makeAvailable();
  await sm.setActive(device.getSettings().storageIdentityKey);
  sm.setServices(services);
  const wallet = new Wallet({ chain: 'main', keyDeriver: kd, storage: sm, services } as never);
  expect(forceLegacyActionBatch(wallet)).toBe(true);

  // One mined coin of 2,000,000 sats, received here.
  const anyone = new PrivateKey(1).toPublicKey().toString();
  const derivationPrefix = Utils.toBase64(Random(8));
  const derivationSuffix = Utils.toBase64(Random(8));
  const priv = kd.derivePrivateKey([2, '3241645161d8'], `${derivationPrefix} ${derivationSuffix}`, anyone);
  const fund = new Transaction();
  fund.addInput({
    sourceTXID: Utils.toHex(Random(32)),
    sourceOutputIndex: 0,
    unlockingScript: new Script(),
    sequence: 0xffffffff,
  });
  fund.addOutput({ lockingScript: new P2PKH().lock(priv.toPublicKey().toAddress()), satoshis: 2_000_000 });
  fund.merklePath = new MerklePath(HEIGHT - 10, [[{ offset: 0, hash: fund.id('hex'), txid: true }]]);
  const fb = new Beef();
  fb.mergeTransaction(fund);
  const fundTxid = fund.id('hex');
  await wallet.internalizeAction({
    tx: fb.toBinaryAtomic(fundTxid),
    outputs: [
      {
        outputIndex: 0,
        protocol: 'wallet payment',
        paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: anyone },
      },
    ],
    description: 'Paymail payment',
  });
  await sm.updateBackups();

  // The Store payment, signed with noSend (stored at once as 'nosend', the coin locked).
  const pay = await wallet.createAction({
    description: 'Theme purchase · Cool',
    outputs: [
      {
        lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()).toHex(),
        satoshis: 600_000,
        outputDescription: 'Theme',
      },
    ],
    options: { noSend: true, randomizeOutputs: false },
  });
  const txid = pay.txid!;
  expect((await txOf(device, txid)).status).toBe('nosend');
  expect((await coinOf(device, fundTxid, 0)).spendable).toBe(false);

  // The push lands on the backup (the device timed out waiting for its answer).
  await sm.updateBackups();
  expect((await txOf(backup, txid)).status).toBe('nosend');
  expect((await coinOf(backup, fundTxid, 0)).spendable).toBe(false);

  // "Backup failed": released here.
  await new Promise((r) => setTimeout(r, 5)); // a later updated_at than the pushed copy
  const r = await wallet.abortAction({ reference: txid });
  expect(r.aborted).toBe(true);
  expect((await txOf(device, txid)).status).toBe('failed');
  expect((await coinOf(device, fundTxid, 0)).spendable).toBe(true);

  // The pull (wallet open, "Sync with my other devices") brings the backup's older 'nosend': it must not win.
  await sm.syncFromReader(kd.identityKey, backup as never);
  expect((await txOf(device, txid)).status).toBe('failed');
  expect((await coinOf(device, fundTxid, 0)).spendable).toBe(true);
  expect(await wallet.balance()).toBe(2_000_000);
  // And a pull from the very beginning (the daily full pass reads every backup row again, the old 'nosend' included).
  const states = (await device.findSyncStates({ partial: {} } as never)) as unknown as { syncStateId: number }[];
  expect(states.length).toBeGreaterThan(0);
  for (const st of states) await device.updateSyncState(st.syncStateId, { when: undefined } as never);
  await sm.syncFromReader(kd.identityKey, backup as never);
  expect((await txOf(device, txid)).status).toBe('failed');
  expect((await coinOf(device, fundTxid, 0)).spendable).toBe(true);
  expect(await wallet.balance()).toBe(2_000_000);

  // The next push frees the coin on the backup too.
  await sm.updateBackups();
  expect((await txOf(backup, txid)).status).toBe('failed');
  const onBackup = await coinOf(backup, fundTxid, 0);
  expect(onBackup.spendable).toBe(true);
  expect(onBackup.spentBy ?? null).toBeNull();
}, 30_000);
