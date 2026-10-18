import { createPasskeyWithPrf, getPrf } from './prf';
import { currentRpId } from './passkeyUi';
import { loadPasskeyUnlock, saveLocalBackup, savePasskeyUnlock, sealPassword, sealSeed } from './seedBackup';

/**
 * Settings › "Add a passkey to this wallet" for an existing password wallet. The password is already verified by
 * the caller. One passkey prompt: reuses the wallet's passkey if it has one (adds this account's backup), else makes
 * a new one. Seals the typed password (so Unlock with passkey works and the password keeps working) and this
 * account's 12 words (same blob format as sign-up).
 */
export async function addPasskeyToWallet(opts: {
  password: string;
  mnemonic?: string;
  account: string;
  label: string;
}): Promise<{ credentialId: string; backedUp: boolean }> {
  const existing = loadPasskeyUnlock();
  const rpId = existing?.rpId ?? currentRpId();
  const { credentialId, prf } = existing
    ? await getPrf(existing.rpId, existing.credentialId)
    : await createPasskeyWithPrf(rpId, `bWalletX · ${opts.label}`);
  try {
    // A passkey-made wallet (no `sealed`) keeps its derived password; otherwise seal the typed one.
    if (!existing || existing.sealed) savePasskeyUnlock(await sealPassword(opts.password, prf, { rpId, credentialId }));
    let backedUp = false;
    if (opts.mnemonic?.trim()) {
      saveLocalBackup(
        await sealSeed(opts.mnemonic, prf, { rpId, credentialId, label: opts.label, account: opts.account }),
      );
      backedUp = true;
    }
    return { credentialId, backedUp };
  } finally {
    prf.fill(0);
  }
}

/**
 * After Settings › Change password: re-seal the new password so Unlock with passkey keeps working (one passkey
 * prompt). Returns 'none' when the wallet has no passkey; on a cancelled prompt the passkey unlock is turned off
 * rather than left pointing at the old password.
 */
export async function resealAfterPasswordChange(newPassword: string): Promise<'none' | 'resealed' | 'turned-off'> {
  const u = loadPasskeyUnlock();
  if (!u) return 'none';
  try {
    const { prf } = await getPrf(u.rpId, u.credentialId);
    savePasskeyUnlock(await sealPassword(newPassword, prf, u));
    prf.fill(0);
    return 'resealed';
  } catch {
    localStorage.removeItem('bwx:passkey-unlock');
    return 'turned-off';
  }
}
