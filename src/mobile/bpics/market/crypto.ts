/**
 * bPics market crypto. Same formats as bit-sign src/lib/bpics-service.ts.
 *
 * Content key: HMAC-SHA256 from the wallet (BRC-42 key derivation, counterparty "self") over a random 16-byte
 * nonce that is written in the listing's MAP. So the photographer can always re-derive the key from their seed
 * (non-custodial; no server needed to open their own photos), and the key is unique per photo.
 *
 * Sealed photo: iv(12) | AES-256-GCM ciphertext with its 16-byte tag at the end (WebCrypto order).
 * Escrow: the content key encrypted (BRC-2) to bit-sign's escrow public key, keyID = the item id.
 * Release: bit-sign encrypts the key (BRC-2) to the buyer's identity key; the buyer decrypts with the escrow key
 * as counterparty.
 */
import { Utils, type WalletInterface, type WalletProtocol } from '@bsv/sdk';

export const CONTENT_PROTOCOL: WalletProtocol = [2, 'bwalletx bpics photo'];
export const ESCROW_PROTOCOL: WalletProtocol = [2, 'bwalletx bpics escrow'];
export const RELEASE_PROTOCOL: WalletProtocol = [2, 'bwalletx bpics release'];

type KeyWallet = Pick<WalletInterface, 'createHmac' | 'encrypt' | 'decrypt'>;

export const newNonce = (): string => Utils.toHex(Array.from(crypto.getRandomValues(new Uint8Array(16))));

export async function deriveContentKey(wallet: KeyWallet, nonceHex: string): Promise<Uint8Array> {
  const { hmac } = await wallet.createHmac({
    data: Utils.toArray(nonceHex, 'hex'),
    protocolID: CONTENT_PROTOCOL,
    keyID: nonceHex,
    counterparty: 'self',
  });
  return Uint8Array.from(hmac);
}

export async function sealPhoto(key: Uint8Array, plain: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const k = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, plain as BufferSource));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

export async function openPhoto(key: Uint8Array, sealed: Uint8Array): Promise<Uint8Array> {
  if (sealed.length < 29) throw new Error('That photo file is damaged.');
  const k = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.slice(0, 12) }, k, sealed.slice(12) as BufferSource),
  );
}

/** The content key wrapped to bit-sign's escrow key (sent once, when the listing is registered). */
export async function wrapForEscrow(wallet: KeyWallet, key: Uint8Array, itemId: string, escrowKey: string) {
  const { ciphertext } = await wallet.encrypt({
    plaintext: Array.from(key),
    protocolID: ESCROW_PROTOCOL,
    keyID: itemId,
    counterparty: escrowKey,
  });
  return Utils.toBase64(ciphertext);
}

/** A key bit-sign released to this wallet after a purchase. */
export async function openRelease(wallet: KeyWallet, wrappedB64: string, itemId: string, escrowKey: string) {
  const { plaintext } = await wallet.decrypt({
    ciphertext: Utils.toArray(wrappedB64, 'base64'),
    protocolID: RELEASE_PROTOCOL,
    keyID: itemId,
    counterparty: escrowKey,
  });
  if (plaintext.length !== 32) throw new Error('That key is not a photo key.');
  return Uint8Array.from(plaintext);
}
