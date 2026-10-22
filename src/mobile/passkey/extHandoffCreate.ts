import { getKeys } from '../../utils/keys';
import { createPasskeyWithPrf } from './prf';
import { currentRpId } from './passkeyUi';
import { uploadBackup } from './passkeyServer';
import { passkeyName, saveLocalBackup, sealSeed, type SeedBackupBlob } from './seedBackup';

/**
 * The extension's "Sign in with a passkey" for someone with no passkey wallet yet (owner, 22 Oct 2026): this page
 * makes the passkey, makes a new wallet's 12 words, seals them with the passkey exactly as web sign-up does (local
 * copy + the signed server copy, so the same passkey restores the wallet on any device), and returns the words for
 * the one-time hand-off to the extension. The words are only returned, never stored in the clear or logged.
 */
export type CreateDeps = {
  rpId: () => string;
  createPasskey: typeof createPasskeyWithPrf;
  newKeys: () => { mnemonic: string; identityWif: string };
  seal: typeof sealSeed;
  saveLocal: (blob: SeedBackupBlob) => void;
  upload: (blob: SeedBackupBlob, identityWif: string) => Promise<boolean>;
};

const defaults: CreateDeps = {
  rpId: currentRpId,
  createPasskey: createPasskeyWithPrf,
  newKeys: () => getKeys(),
  seal: sealSeed,
  saveLocal: (b) => saveLocalBackup(b),
  upload: (b, wif) => uploadBackup(b, wif),
};

export async function createPasskeyWalletForExtension(
  d: CreateDeps = defaults,
): Promise<{ words: string; savedOnline: boolean }> {
  const rpId = d.rpId();
  const label = passkeyName();
  const { credentialId, prf } = await d.createPasskey(rpId, label);
  try {
    const keys = d.newKeys();
    const blob = await d.seal(keys.mnemonic, prf, { rpId, credentialId, label });
    d.saveLocal(blob);
    const savedOnline = await d.upload(blob, keys.identityWif).catch(() => false);
    return { words: keys.mnemonic, savedOnline };
  } finally {
    prf.fill(0);
  }
}
