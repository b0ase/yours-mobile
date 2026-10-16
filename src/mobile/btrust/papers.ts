// bTrust "Important papers": encrypt a document under the trust key so heirs can open it with the slices.
// The encrypted file stays with the user (download / their own storage). Only its SHA-256 is ever meant
// for the chain, as a reference; the plaintext and the key never leave the device.

import { Hash, PrivateKey, SymmetricKey, Utils } from '@bsv/sdk';

export const PAPER_MAGIC = 'btrust-paper-1';

export type SealedPaper = {
  magic: typeof PAPER_MAGIC;
  name: string;
  type: string;
  /** SHA-256 of the plaintext (what an on-chain reference would record). */
  sha256: string;
  /** base64 AES-256-GCM ciphertext. */
  data: string;
};

export function sealPaper(
  trustKey: PrivateKey,
  file: { name: string; type?: string; bytes: Uint8Array | number[] },
): SealedPaper {
  const bytes = Array.from(file.bytes);
  if (bytes.length === 0) throw new Error('the file is empty');
  if (bytes.length > 20 * 1024 * 1024) throw new Error('papers are limited to 20 MB');
  const cipher = new SymmetricKey(trustKey.toArray('be', 32)).encrypt(bytes) as number[];
  return {
    magic: PAPER_MAGIC,
    name: file.name.slice(0, 200),
    type: file.type || 'application/octet-stream',
    sha256: Utils.toHex(Hash.sha256(bytes)),
    data: Utils.toBase64(cipher),
  };
}

/** Opens a sealed paper and checks it against its recorded hash. */
export function openPaper(trustKey: PrivateKey, paper: SealedPaper): number[] {
  if (paper.magic !== PAPER_MAGIC) throw new Error('not a bTrust paper');
  let bytes: number[];
  try {
    bytes = new SymmetricKey(trustKey.toArray('be', 32)).decrypt(Utils.toArray(paper.data, 'base64')) as number[];
  } catch {
    throw new Error('these slices do not open this paper');
  }
  if (Utils.toHex(Hash.sha256(bytes)) !== paper.sha256) throw new Error('this paper has been changed');
  return bytes;
}

export const parsePaper = (json: string): SealedPaper => {
  const p = JSON.parse(json) as SealedPaper;
  if (p?.magic !== PAPER_MAGIC || typeof p.data !== 'string' || typeof p.sha256 !== 'string')
    throw new Error('not a bTrust paper');
  return p;
};
