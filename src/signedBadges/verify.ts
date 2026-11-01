/**
 * Check and make AuthSig-format proofs (record.ts) with @bsv/sdk. Used by the background only.
 *
 * A badge is drawn only for a proof that passes every check here: the KV token's controller signature (checked by
 * GlobalKVStore before we see the entry), protocol [1,"authsig"], value.publicKey == controller, the content hash
 * (and the key, for a content-hash key), and the content signature itself. AuthSig 1.0.2 draws badges without
 * checking the content signature; we don't.
 */
import { Hash, ProtoWallet, Utils, type WalletInterface } from '@bsv/sdk';
import {
  AUTHSIG_KEY_ID,
  AUTHSIG_PROTOCOL_ID,
  AUTHSIG_VERSION,
  MAX_CONTENT_CHARS,
  decodeProofValue,
  encodeProofValue,
  isContentHashKey,
  xPostIdFromKey,
  type ProofValue,
  type VerifiedProof,
} from './record';

export const sha256Hex = (text: string): string => Utils.toHex(Hash.sha256(Utils.toArray(text, 'utf8')));

/** What GlobalKVStore.get returns per entry (the parts we read). */
export type KvEntry = {
  key: string;
  value: string;
  controller: string;
  protocolID: [number, string] | readonly unknown[];
  token?: { txid: string; outputIndex: number };
};

const anyone = new ProtoWallet('anyone');

/**
 * One overlay entry → a verified proof, or null. `pageText`: the page text the caller hashed to this key, used
 * when the record leaves its content out.
 */
export const verifyEntry = async (entry: KvEntry, pageText?: string): Promise<VerifiedProof | null> => {
  try {
    if (JSON.stringify(entry.protocolID) !== JSON.stringify(AUTHSIG_PROTOCOL_ID)) return null;
    const v = decodeProofValue(entry.value);
    if (!v || v.protocol !== AUTHSIG_VERSION) return null;
    if (v.publicKey !== String(entry.controller).toLowerCase()) return null;
    const hashKey = isContentHashKey(entry.key);
    const xId = xPostIdFromKey(entry.key);
    if (!hashKey && !xId) return null;
    if (xId && v.postId !== undefined && v.postId !== xId) return null;
    let content = v.content;
    if (content === undefined && hashKey && pageText !== undefined && sha256Hex(pageText) === entry.key)
      content = pageText;
    if (content === undefined || content.length === 0 || content.length > MAX_CONTENT_CHARS) return null;
    const hash = sha256Hex(content);
    if (v.contentHash !== undefined && v.contentHash !== hash) return null;
    if (hashKey && entry.key !== hash) return null;
    const { valid } = await anyone.verifySignature({
      protocolID: AUTHSIG_PROTOCOL_ID,
      keyID: AUTHSIG_KEY_ID,
      counterparty: v.publicKey,
      data: Utils.toArray(content, 'utf8'),
      signature: Utils.toArray(v.signature, 'hex'),
    });
    if (valid !== true) return null;
    return {
      key: entry.key,
      content,
      publicKey: v.publicKey,
      signedAt: v.signedAt,
      outpoint: entry.token ? `${entry.token.txid}.${entry.token.outputIndex}` : undefined,
      source: v.signer || v.platform ? 'bwalletx' : 'authsig',
      ...(v.pageUrl ? { pageUrl: v.pageUrl } : {}),
      ...(v.platform ? { platform: v.platform } : {}),
      ...(v.signer ? { claimedName: v.signer } : {}),
    };
  } catch {
    return null;
  }
};

/** What a signing call writes: the key and our optional fields. Content is exactly what the user saw on the sheet. */
export type SignInput = {
  key: string;
  content: string;
  extras?: Pick<ProofValue, 'signer' | 'pageUrl' | 'platform' | 'postId' | 'authorHandle'>;
};

/** The part of GlobalKVStore the signer needs (tests pass a fake). */
export type ProofStore = {
  set: (
    key: string,
    value: string,
    options: { protocolID: [1, string]; tokenSetDescription: string; tokenUpdateDescription: string },
  ) => Promise<string>;
};

/**
 * Sign `content` with the wallet's identity-derived AuthSig key and write the record. The wallet must be the
 * wallet itself (admin): the user already approved this exact text and fee on the one sheet.
 */
export const signProof = async (
  wallet: Pick<WalletInterface, 'getPublicKey' | 'createSignature'>,
  store: ProofStore,
  input: SignInput,
  now: () => Date = () => new Date(),
): Promise<{ outpoint: string; value: string; publicKey: string }> => {
  if (!input.content || input.content.length > MAX_CONTENT_CHARS) throw new Error('Nothing to sign');
  const contentHash = sha256Hex(input.content);
  if (isContentHashKey(input.key) ? input.key !== contentHash : !xPostIdFromKey(input.key))
    throw new Error('Bad proof key');
  const { publicKey } = await wallet.getPublicKey({ identityKey: true });
  const { signature } = await wallet.createSignature({
    data: Utils.toArray(input.content, 'utf8'),
    protocolID: AUTHSIG_PROTOCOL_ID,
    keyID: AUTHSIG_KEY_ID,
    counterparty: 'anyone',
  });
  const value = encodeProofValue({
    signature: Utils.toHex(signature),
    publicKey,
    signedAt: now().toISOString(),
    protocol: AUTHSIG_VERSION,
    content: input.content,
    contentHash,
    ...input.extras,
  });
  const outpoint = await store.set(input.key, value, {
    protocolID: AUTHSIG_PROTOCOL_ID,
    tokenSetDescription: 'bWalletX: record signed post proof',
    tokenUpdateDescription: 'bWalletX: update signed post proof',
  });
  return { outpoint, value, publicKey };
};

/**
 * Rough network fee for one proof token, shown on the sheet before the wallet builds the real transaction: one
 * input, change, and the PushDrop output carrying the key and value (~440 bytes plus the key and value), plus the
 * 1-sat token itself.
 */
export const estimateProofSats = (key: string, value: string, satsPerKb: number): number => {
  const bytes = 440 + Utils.toArray(key, 'utf8').length + Utils.toArray(value, 'utf8').length;
  const rate = Number.isFinite(satsPerKb) && satsPerKb > 0 ? satsPerKb : 100;
  return 1 + Math.max(1, Math.ceil((bytes * rate) / 1000));
};
