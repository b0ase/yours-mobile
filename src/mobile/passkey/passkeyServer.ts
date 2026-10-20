import { BSM, Hash, PrivateKey, Utils } from '@bsv/sdk';
import { BCHAT_ORIGIN } from '../chat/api';
import { parseSeedBackup, type SeedBackupBlob } from './seedBackup';

/**
 * Server copy of the passkey seed backup (bit-sign /api/bitsign/passkey-backups, ciphertext only). Lets "Restore
 * with a passkey" work on a device with no local copy or file. The upload is signed by the wallet's identity key
 * (first upload claims the credential id; only that key can replace it). Best effort: the local copy and the
 * recovery file stay the fallback, and the store answers 503 until its migration has run.
 */
export const passkeyBackupApi = (): string =>
  (import.meta.env.VITE_PASSKEY_BACKUP_URL as string | undefined) || `${BCHAT_ORIGIN}/api/bitsign/passkey-backups`;

/** Same string bit-sign verifies (src/lib/passkey-backups.ts putMessage). */
export const putMessage = (credentialId: string, hashHex: string, ts: number) =>
  `bwalletx passkey backup v1|${credentialId}|${hashHex}|${ts}`;

/**
 * What the server gets: the blob WITHOUT its optional `label` and `account` fields (review 20 Oct 2026). GET is
 * public by credential id, so an account address in the blob would link a credential to a wallet address for anyone,
 * and a label like a device name is personal. Neither is part of the encrypted header (aad covers version, rpId,
 * credential id and salt only), so the server copy still decrypts. The local copy and the recovery file keep both.
 */
export const serverCopy = (blob: SeedBackupBlob): SeedBackupBlob => {
  const { account: _account, label: _label, ...rest } = blob;
  return rest;
};

export function signedPut(blob: SeedBackupBlob, identityWif: string, ts = Date.now()) {
  blob = serverCopy(blob);
  const json = JSON.stringify(blob);
  const hash = Utils.toHex(Hash.sha256(Utils.toArray(json, 'utf8')));
  const key = PrivateKey.fromWif(identityWif);
  const signature = BSM.sign(Utils.toArray(putMessage(blob.credentialId, hash, ts), 'utf8'), key, 'base64') as string;
  return { blob, identity_key: key.toPublicKey().toString(), ts, signature };
}

export async function uploadBackup(
  blob: SeedBackupBlob,
  identityWif: string,
  fetcher: typeof fetch = fetch,
  tries = 3,
): Promise<boolean> {
  // A few tries: right after sign-up the page is busy (wallet storage starting, the file download), and a
  // request can be cut off. Each try is signed fresh (the server allows a 5-minute clock window).
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetcher(passkeyBackupApi(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signedPut(blob, identityWif)),
      });
      if (r.ok) return true;
      console.warn('[passkey-backup] upload refused', r.status);
      if (r.status >= 400 && r.status < 500 && r.status !== 429) return false;
    } catch (e) {
      console.warn('[passkey-backup] upload try failed', i + 1, e);
    }
    await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
  }
  return false;
}

export async function fetchBackup(credentialId: string, fetcher: typeof fetch = fetch): Promise<SeedBackupBlob | null> {
  try {
    const r = await fetcher(`${passkeyBackupApi()}/${encodeURIComponent(credentialId)}`);
    if (!r.ok) return null;
    const j = (await r.json()) as { blob?: unknown };
    const b = parseSeedBackup(JSON.stringify(j.blob));
    return b.credentialId === credentialId ? b : null;
  } catch {
    return null;
  }
}
