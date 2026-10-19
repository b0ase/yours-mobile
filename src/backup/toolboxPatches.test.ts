/**
 * The two wallet-toolbox patches behind the 19 Oct 2026 console errors (patches/@bopen-io__wallet-toolbox-client*.patch):
 *  - Monitor.logEvent with a remote (StorageClient) active store threw 'Active "WalletStorageProvider" does not
 *    support "StorageProvider" interface', so every runOnce that logged an event rejected;
 *  - the IndexedDB invalid-change review with ['release', 'all'] passed basketId: undefined to findOutputs, which
 *    refuses undefined filters, so the post-restore UTXO review always failed on a local store.
 * Local only: fake-indexeddb, random keys, no network.
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { KeyDeriver, PrivateKey } from '@bsv/sdk';
import { Monitor, Services, StorageIdb, StorageProvider, WalletStorageManager } from '@bsv/wallet-toolbox-client';
import { WalletBackupService } from './WalletBackupService';

let dbn = 0;
const localManager = async () => {
  const kd = new KeyDeriver(PrivateKey.fromRandom());
  const s = new StorageIdb(StorageProvider.createStorageBaseOptions('main'));
  await s.migrate(`patch-test-${Date.now()}-${dbn++}`, PrivateKey.fromRandom().toPublicKey().toString());
  await s.makeAvailable();
  const storage = new WalletStorageManager(kd.identityKey, s);
  await storage.makeAvailable();
  // No outputs, so the review makes no service calls; it only needs services set.
  storage.setServices(new Services('main'));
  return { storage, identityKey: kd.identityKey };
};

describe('wallet-toolbox patches', () => {
  test('the invalid-change review across all baskets runs on an IndexedDB store', async () => {
    const { storage, identityKey } = await localManager();
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a);
    try {
      expect(await WalletBackupService.reviewRestoredUtxos(storage, identityKey)).toBe(0);
    } finally {
      console.error = orig;
    }
    expect(errors).toEqual([]);
  });

  test('Monitor.logEvent does not throw when the active store is remote', async () => {
    const { storage } = await localManager();
    const monitor = new Monitor({
      chain: 'main',
      services: new Services('main'),
      storage,
      chaintracks: new Services('main').options.chaintracks!,
      msecsWaitPerMerkleProofServiceReq: 500,
      taskRunWaitMsecs: 5000,
      abandonedMsecs: 300000,
      unprovenAttemptsLimitTest: 10,
      unprovenAttemptsLimitMain: 144,
      maxRebroadcastAttempts: 0,
    });
    // A StorageClient answers false here, and runAsStorageProvider throws for it.
    storage.isStorageProvider = () => false;
    storage.runAsStorageProvider = async () => {
      throw new Error('Active "WalletStorageProvider" does not support "StorageProvider" interface.');
    };
    await expect(monitor.logEvent('chaintracksEventsError', 'unavailable')).resolves.toBeUndefined();
  });
});
