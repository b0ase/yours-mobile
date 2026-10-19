import { describe, expect, test } from 'bun:test';
import { sdk } from '@bsv/wallet-toolbox-client';
import { WalletBackupService } from './WalletBackupService';

type Storage = Parameters<typeof WalletBackupService.reviewRestoredUtxos>[0];

/** A manager whose active store is remote: only the manager-level calls exist (no runAsStorageProvider). */
const remoteManager = (identityKey: string, totalOutputs: number) => {
  const calls: unknown[] = [];
  const storage = {
    getAuth: async () => ({ identityKey, userId: 7, isActive: true }),
    listOutputs: async (args: unknown) => {
      calls.push(args);
      return { totalOutputs, outputs: [] };
    },
  } as unknown as Storage;
  return { storage, calls };
};

describe('post-restore UTXO review', () => {
  test('runs the invalid-change release through the manager, so a remote active store works', async () => {
    const { storage, calls } = remoteManager('02aa', 3);
    expect(await WalletBackupService.reviewRestoredUtxos(storage, '02aa')).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ basket: sdk.specOpInvalidChange, tags: ['release', 'all'], tagQueryMode: 'all' });
  });

  test("never reviews another identity's outputs", async () => {
    const { storage, calls } = remoteManager('02aa', 3);
    expect(await WalletBackupService.reviewRestoredUtxos(storage, '02bb')).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
