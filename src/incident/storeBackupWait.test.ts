/**
 * Final review 18, F-A: a Store payment's backup-before-send (deviceSync.pushNow, 60 s limit) waits for any device sync
 * already running. The open-time pull used to AWAIT the whole admission run, so on the first open after the release a
 * Store payment could fail with "the backup took too long". The pull now only schedules admission (pullThenAdmitSoon,
 * as initWallet wires it). Real StorageIdb x2, WalletStorageManager, the real inbound guard, real admitPending, real
 * createDeviceSync + backupBeforeSend. The chain answers at a fixed pace per call (60 ms, about 1/6 of real time).
 */
import 'fake-indexeddb/auto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Beef, KeyDeriver, MerklePath, P2PKH, PrivateKey, Random, Script, Transaction, Utils } from '@bsv/sdk';
import { StorageIdb, StorageProvider, Wallet, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as IS from '../services/inboundSync';
import { backupBeforeSend, createDeviceSync, pullThenAdmitSoon } from '../services/deviceSync';

const HEIGHT = 971_004;
const services = new Proxy(
  {
    chain: 'main',
    getChainTracker: async () => ({ isValidRootForHeight: async () => true, currentHeight: async () => HEIGHT + 1 }),
    getHeight: async () => HEIGHT + 1,
    getHeaderForHeight: async () => new Array(80).fill(0),
    nLockTimeIsFinal: async () => true,
    hashOutputScript: (s: string) => s,
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

test('a Store payment backup is not held up by the open-time admission run', async () => {
  const root = PrivateKey.fromRandom();
  const kd = new KeyDeriver(root);
  const remote = await store('f2-remote');
  IS._mergeUnchecked(remote);
  // The other device (already on the backup) received 40 coins.
  const other = await store('f2-other');
  IS._mergeUnchecked(other);
  const smO = new WalletStorageManager(kd.identityKey, other, [remote]);
  await smO.makeAvailable();
  await smO.setActive(other.getSettings().storageIdentityKey);
  smO.setServices(services);
  const wO = new Wallet({ chain: 'main', keyDeriver: kd, storage: smO, services } as never);
  const anyone = new PrivateKey(1).toPublicKey().toString();
  for (let i = 0; i < 40; i++) {
    const derivationPrefix = Utils.toBase64(Random(8));
    const derivationSuffix = Utils.toBase64(Random(8));
    const priv = kd.derivePrivateKey([2, '3241645161d8'], `${derivationPrefix} ${derivationSuffix}`, anyone);
    const tx = new Transaction();
    tx.addInput({
      sourceTXID: Utils.toHex(Random(32)),
      sourceOutputIndex: 0,
      unlockingScript: new Script(),
      sequence: 0xffffffff,
    });
    tx.addOutput({ lockingScript: new P2PKH().lock(priv.toPublicKey().toAddress()), satoshis: 10_000 + i });
    tx.merklePath = new MerklePath(HEIGHT - 50 + i, [[{ offset: 0, hash: tx.id('hex'), txid: true }]]);
    const b = new Beef();
    b.mergeTransaction(tx);
    await wO.internalizeAction({
      tx: b.toBinaryAtomic(tx.id('hex')),
      outputs: [
        {
          outputIndex: 0,
          protocol: 'wallet payment',
          paymentRemittance: { derivationPrefix, derivationSuffix, senderIdentityKey: anyone },
        },
      ],
      description: 'Paymail payment',
    });
  }
  await smO.updateBackups();

  // This device (the phone), its own store active, pulls on open.
  const phone = await store('f2-phone');
  const PACE = 60;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const verifier = {
    owns: IS.walletOwnership(root),
    spent: async () => (await sleep(PACE), { state: 'unspent' as const }),
    txKnown: async () => (await sleep(PACE), 'known' as const),
    readRecord: IS.walletRecords(root),
    log: () => undefined,
  };
  IS.registerInboundVerifier(phone.getSettings().storageIdentityKey, kd.identityKey, verifier);
  const sm = new WalletStorageManager(kd.identityKey, phone, [remote]);
  await sm.makeAvailable();
  await sm.setActive(phone.getSettings().storageIdentityKey);
  sm.setServices(services);
  let admission: Promise<unknown> | undefined;
  const admitSoon = () => {
    admission = new Promise((r) => setTimeout(r, 0)).then(() =>
      IS.admitPending(phone as never, kd.identityKey, verifier),
    );
  };
  const sync = createDeviceSync({
    applies: () => true,
    ensureBackup: async () => true,
    // initWallet's pull, as wired now (initWallet.ts: pullThenAdmitSoon(merge, () => admitIn(0)))
    pull: pullThenAdmitSoon(async () => {
      await sm.syncFromReader(kd.identityKey, remote as never);
    }, admitSoon),
    push: async () => void (await sm.updateBackups()),
  });
  const opening = sync.syncNow(); // the wallet opens
  await sleep(20);
  // The person taps Pay in the Store: the backup push must go through first (60 s in the app; here 1.5 s = ~9 s real).
  const b = await backupBeforeSend({
    deviceActive: () => true,
    backupConfigured: () => true,
    pushNow: () => sync.pushNow(),
    timeoutMs: 1_500,
  });
  await opening;
  expect(b.ok).toBe(true);
  // The held coins are still admitted, just after the pull rather than inside it.
  expect(admission).toBeDefined();
  await admission;
  // Each admission run works through a batch; the app runs again at the report's nextAt (initWallet admitIn).
  let spendable = (await phone.findOutputs({ partial: { spendable: true } } as never)) as unknown[];
  for (let run = 0; run < 5 && spendable.length < 40; run++) {
    await IS.admitPending(phone as never, kd.identityKey, verifier);
    spendable = (await phone.findOutputs({ partial: { spendable: true } } as never)) as unknown[];
  }
  expect(spendable.length).toBe(40);
}, 30_000);

test('initWallet wires the pull through pullThenAdmitSoon and never awaits admission inside it', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'initWallet.ts'), 'utf8');
  const pull = src.slice(
    src.indexOf('pull: pullThenAdmitSoon('),
    src.indexOf('push: async () =>', src.indexOf('pull: pullThenAdmitSoon(')),
  );
  expect(pull.length).toBeGreaterThan(0);
  expect(pull).toContain('admitIn(0)');
  expect(pull).not.toContain('await admitBackupRows()');
});
