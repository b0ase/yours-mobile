// bTrust "Recovery slices": split a secret into n-of-m cards to hand to people you trust.
//
// A fresh random 32-byte trust key encrypts the secret (AES-256-GCM, @bsv/sdk SymmetricKey). The trust key
// is split with @bsv/sdk's audited Shamir backup shares (PrivateKey.toBackupShares: threshold, integrity
// hash and share index are in every share). Each card carries one share PLUS the ciphertext, so any
// `threshold` cards restore the secret with no server and no other file. One card alone reveals nothing.
//
// Nothing here logs, stores or sends key material; callers hold the cards in memory until the user saves them.

import { Hash, PrivateKey, SymmetricKey, Utils } from '@bsv/sdk';

export const CARD_PREFIX = 'btrust1';
export const DEFAULT_THRESHOLD = 2;
export const DEFAULT_TOTAL = 3;

export type SliceCard = {
  /** Short id shared by every card of one set (first 8 hex of the ciphertext hash). */
  setId: string;
  index: number;
  total: number;
  threshold: number;
  /** The full text to print / encode as a QR. */
  text: string;
};

const b64 = (a: number[]) => Utils.toBase64(a);

export function checkCounts(threshold: number, total: number) {
  if (!Number.isInteger(threshold) || !Number.isInteger(total)) throw new Error('counts must be whole numbers');
  if (threshold < 2) throw new Error('at least 2 slices must be needed to restore');
  if (total < threshold || total > 16) throw new Error('total must be between the threshold and 16');
}

/** Encrypts `secret` under a new trust key and returns the cards (and the trust key, for papers). */
export function makeSlices(
  secret: Uint8Array | number[],
  threshold = DEFAULT_THRESHOLD,
  total = DEFAULT_TOTAL,
): { cards: SliceCard[]; trustKey: PrivateKey } {
  checkCounts(threshold, total);
  if (secret.length === 0) throw new Error('nothing to protect');
  const trustKey = PrivateKey.fromRandom();
  return { cards: slicesForKey(trustKey, secret, threshold, total), trustKey };
}

/** Same as makeSlices with an existing trust key (so papers and the backup share one key). */
export function slicesForKey(
  trustKey: PrivateKey,
  secret: Uint8Array | number[],
  threshold = DEFAULT_THRESHOLD,
  total = DEFAULT_TOTAL,
): SliceCard[] {
  checkCounts(threshold, total);
  const cipher = new SymmetricKey(trustKey.toArray('be', 32)).encrypt(Array.from(secret)) as number[];
  const setId = Utils.toHex(Hash.sha256(cipher)).slice(0, 8);
  const shares = trustKey.toBackupShares(threshold, total);
  return shares.map((share, i) => ({
    setId,
    index: i + 1,
    total,
    threshold,
    text: [CARD_PREFIX, setId, `${i + 1}/${total}`, share, b64(cipher)].join(':'),
  }));
}

type Parsed = { setId: string; index: number; total: number; share: string; cipher: number[] };

export function parseCard(text: string): Parsed {
  const parts = text.trim().split(':');
  if (parts.length !== 5 || parts[0] !== CARD_PREFIX) throw new Error('not a bTrust slice');
  const [, setId, pos, share, c] = parts;
  const m = /^(\d+)\/(\d+)$/.exec(pos);
  if (!m || !/^[0-9a-f]{8}$/.test(setId)) throw new Error('not a bTrust slice');
  const cipher = Utils.toArray(c, 'base64');
  if (Utils.toHex(Hash.sha256(cipher)).slice(0, 8) !== setId) throw new Error('this slice is damaged');
  return { setId, index: Number(m[1]), total: Number(m[2]), share, cipher };
}

/** Restores the trust key from enough cards (throws with a plain message otherwise). */
export function restoreKey(texts: string[]): { trustKey: PrivateKey; cipher: number[] } {
  const parsed = texts.filter((t) => t.trim()).map(parseCard);
  if (parsed.length < 2) throw new Error('add at least two slices');
  if (new Set(parsed.map((p) => p.setId)).size !== 1) throw new Error('these slices are from different sets');
  const c0 = Utils.toHex(parsed[0].cipher);
  if (parsed.some((p) => Utils.toHex(p.cipher) !== c0)) throw new Error('these slices are from different sets');
  const unique = [...new Map(parsed.map((p) => [p.index, p])).values()];
  if (unique.length < 2) throw new Error('these are copies of the same slice; add a different one');
  let trustKey: PrivateKey;
  try {
    trustKey = PrivateKey.fromBackupShares(unique.map((p) => p.share));
  } catch {
    throw new Error('not enough slices, or a slice is wrong');
  }
  return { trustKey, cipher: unique[0].cipher };
}

/** Restores the protected secret from any `threshold` cards. */
export function restoreSecret(texts: string[]): number[] {
  const { trustKey, cipher } = restoreKey(texts);
  try {
    return new SymmetricKey(trustKey.toArray('be', 32)).decrypt(cipher) as number[];
  } catch {
    throw new Error('not enough slices, or a slice is wrong');
  }
}
