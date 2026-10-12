import { PrivateKey, ProtoWallet, Utils, type WalletProtocol } from '@bsv/sdk';

/**
 * Segment crypto. Each sealed segment is iv(12) | tag(16) | ciphertext, AES-256-GCM (bitcoin-music
 * scripts/bmusic/stream-pack.ts). WebCrypto wants ciphertext | tag, so the tag is moved to the end.
 */
export async function openSegment(key: Uint8Array, sealed: Uint8Array): Promise<Uint8Array> {
  if (sealed.length < 28) throw new Error('Segment too short');
  const iv = sealed.slice(0, 12);
  const tag = sealed.slice(12, 28);
  const ct = sealed.slice(28);
  const body = new Uint8Array(ct.length + 16);
  body.set(ct);
  body.set(tag, ct.length);
  const k = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, k, body));
}

/**
 * Unwrap a segment key the server encrypted (BRC-2) to the session key: the session key is the recipient,
 * counterparty = the server identity key, protocol / keyID as the server sent them.
 */
export async function unwrapKey(
  sessionKey: PrivateKey,
  wrappedKeyB64: string,
  protocolID: WalletProtocol,
  keyID: string,
  serverIdentityKey: string,
): Promise<Uint8Array> {
  const { plaintext } = await new ProtoWallet(sessionKey).decrypt({
    ciphertext: Utils.toArray(wrappedKeyB64, 'base64'),
    protocolID,
    keyID,
    counterparty: serverIdentityKey,
  });
  return Uint8Array.from(plaintext);
}
