/**
 * Backup file envelope v2 (owner, 14 Oct 2026): a stronger lock for NEW backup files only.
 *
 * The master backup ZIP (WalletBackupService) keeps its keys under the wallet passKey (PBKDF2-SHA256, 100k,
 * src/utils/crypto.ts deriveKey), which is also what unlocks the wallet and must not change. New backup files
 * wrap that whole ZIP with AES-256-GCM under a key from PBKDF2-SHA256 at 600,000 iterations (Web Crypto, no new
 * dependency), with its own random salt. The outer file is still a ZIP (so every file picker that accepts .zip
 * takes it) holding two entries:
 *   bwallet-backup.json  { format, version: 2, kdf, hash, iterations, salt, iv }
 *   payload.bin          AES-GCM(inner master-backup ZIP)
 * Old files (a plain master-backup ZIP, or a legacy one) carry no bwallet-backup.json and restore as before.
 */
import { unzipSync, zipSync, type Unzipped } from 'fflate';

export const ENVELOPE_ENTRY = 'bwallet-backup.json';
export const PAYLOAD_ENTRY = 'payload.bin';
export const ENVELOPE_FORMAT = 'bwallet-backup';
export const ENVELOPE_VERSION = 2;
export const ENVELOPE_ITERATIONS = 600_000;
/** Restore refuses headers outside this range: below is weaker than we ever wrote, above is a hang. */
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 10_000_000;

export type EnvelopeHeader = {
  format: typeof ENVELOPE_FORMAT;
  version: number;
  kdf: 'PBKDF2';
  hash: 'SHA-256';
  iterations: number;
  /** hex */
  salt: string;
  /** hex, 12 bytes */
  iv: string;
};

export class BackupPasswordError extends Error {
  constructor() {
    super('Incorrect password for this backup file');
    this.name = 'BackupPasswordError';
  }
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => {
  if (!/^(?:[0-9a-f]{2})+$/i.test(h)) throw new Error('Invalid backup file: bad header');
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
};
const ab = (u: Uint8Array): ArrayBuffer => u.slice().buffer as ArrayBuffer;

const deriveAesKey = async (password: string, salt: Uint8Array, iterations: number) => {
  const base = await crypto.subtle.importKey('raw', ab(new TextEncoder().encode(password)), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: ab(salt), iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
};

/** Wraps an inner master-backup ZIP into a v2 envelope file. */
export const sealBackup = async (
  inner: Uint8Array,
  password: string,
  iterations = ENVELOPE_ITERATIONS,
): Promise<Uint8Array> => {
  if (!password) throw new BackupPasswordError();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(password, salt, iterations);
  const header: EnvelopeHeader = {
    format: ENVELOPE_FORMAT,
    version: ENVELOPE_VERSION,
    kdf: 'PBKDF2',
    hash: 'SHA-256',
    iterations,
    salt: toHex(salt),
    iv: toHex(iv),
  };
  // The header is the GCM additional data: editing it (e.g. lowering iterations) breaks decryption.
  const aad = new TextEncoder().encode(JSON.stringify(header));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ab(iv), additionalData: ab(aad) }, key, ab(inner)),
  );
  // Stored, not deflated: ciphertext doesn't compress.
  return zipSync({ [ENVELOPE_ENTRY]: [aad, { level: 0 }], [PAYLOAD_ENTRY]: [ct, { level: 0 }] });
};

/** The header if this unzipped file is a v2 envelope, else null (an old-format backup). */
export const envelopeHeader = (files: Unzipped): EnvelopeHeader | null => {
  const raw = files[ENVELOPE_ENTRY];
  if (!raw) return null;
  let h: Partial<EnvelopeHeader>;
  try {
    h = JSON.parse(new TextDecoder().decode(raw)) as Partial<EnvelopeHeader>;
  } catch {
    throw new Error('Invalid backup file: unreadable header');
  }
  if (h.format !== ENVELOPE_FORMAT) throw new Error('Invalid backup file: unknown format');
  if (h.version !== ENVELOPE_VERSION) throw new Error('This backup was made by a newer version. Update the app.');
  if (h.kdf !== 'PBKDF2' || h.hash !== 'SHA-256') throw new Error('Invalid backup file: unknown key derivation');
  if (
    typeof h.iterations !== 'number' ||
    !Number.isInteger(h.iterations) ||
    h.iterations < MIN_ITERATIONS ||
    h.iterations > MAX_ITERATIONS
  )
    throw new Error('Invalid backup file: bad key derivation settings');
  if (typeof h.salt !== 'string' || typeof h.iv !== 'string') throw new Error('Invalid backup file: bad header');
  return h as EnvelopeHeader;
};

/**
 * Opens any backup file: a v2 envelope is decrypted with the password and its inner ZIP returned unzipped;
 * an old file is returned unzipped as it is (its keys are still checked by the restore itself).
 */
export const openBackup = async (
  fileBytes: Uint8Array,
  password: string,
  unzip: (data: Uint8Array) => Promise<Unzipped> = async (d) => unzipSync(d),
): Promise<{ files: Unzipped; version: 1 | 2 }> => {
  const outer = await unzip(fileBytes);
  const header = envelopeHeader(outer);
  if (!header) return { files: outer, version: 1 };
  const ct = outer[PAYLOAD_ENTRY];
  if (!ct) throw new Error('Invalid backup file: missing payload');
  const key = await deriveAesKey(password, fromHex(header.salt), header.iterations);
  let inner: Uint8Array;
  try {
    inner = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: ab(fromHex(header.iv)), additionalData: ab(outer[ENVELOPE_ENTRY]) },
        key,
        ab(ct),
      ),
    );
  } catch {
    throw new BackupPasswordError();
  }
  return { files: await unzip(inner), version: 2 };
};
