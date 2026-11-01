/**
 * Signed post proofs in Babbage AuthSig's on-chain format, so a badge drawn by bWalletX and one drawn by AuthSig
 * (Chrome extension bkliibmeeeiifhjiclaaplaopoomlboc, v1.0.2) read each other's records. Learnt from AuthSig's
 * built bundle and checked against live mainnet records (no AuthSig code is copied; it has no published licence).
 *
 * Storage: the BSV overlay GlobalKVStore (service ls_kvstore, topic tm_kvstore, one 1-sat PushDrop token per
 * record), protocolID [1, "authsig"], controller = the signer's identity key, no tags.
 *
 * Key:
 *   x-post-<status id>          a post on X (x.com/<user>/status/<id>)
 *   <sha256 hex of content>     anything else (selected text, a post elsewhere)
 *
 * Value (a JSON string, fields in this order):
 *   { signature, publicKey, signedAt, protocol: "authsig-v1", content, contentHash }
 *   signature   DER hex of createSignature({ data: utf8(content), protocolID: [1,"authsig"],
 *               keyID: "content-signing", counterparty: "anyone" })
 *   publicKey   the signer's identity key (equals the token's controller)
 *   contentHash sha256 hex of utf8(content)
 * Some content-hash records leave `content` (and `contentHash`) out: the page text that hashes to the key is the
 * content then.
 *
 * bWalletX adds optional fields after those (AuthSig ignores fields it doesn't know; they are covered by the
 * token's own controller signature): signer ($name claimed by the signer, checked against our paymail before it is
 * shown), pageUrl, platform, postId, authorHandle.
 *
 * Pure: no DOM, no network, no wallet. Shared by the content script and the background.
 */

export const AUTHSIG_PROTOCOL_ID: [1, string] = [1, 'authsig'];
export const AUTHSIG_KEY_ID = 'content-signing';
export const AUTHSIG_VERSION = 'authsig-v1';
const X_POST_PREFIX = 'x-post-';

/** Longest content we sign or accept (a long LinkedIn post is ~3,000 characters; GitHub comments can be longer). */
export const MAX_CONTENT_CHARS = 20_000;

export type ProofValue = {
  signature: string;
  publicKey: string;
  signedAt: string;
  protocol: string;
  content?: string;
  contentHash?: string;
  /** bWalletX: the signer's own $name (verified by readers against the paymail binding before it is shown). */
  signer?: string;
  pageUrl?: string;
  platform?: string;
  postId?: string;
  authorHandle?: string;
};

const HEX = /^[0-9a-f]*$/i;
const STATUS_ID = /^\d{1,25}$/;
export const SIGNER_RE = /^\$[a-z0-9](?:[a-z0-9_.-]{0,48}[a-z0-9])?$/;

/** The KV key for a post on X, AuthSig's `x-post-<id>`. */
export const xPostKey = (statusId: string): string | undefined =>
  STATUS_ID.test(statusId) ? `${X_POST_PREFIX}${statusId}` : undefined;

/** The status id inside an `x-post-<id>` key. */
export const xPostIdFromKey = (key: string): string | undefined => {
  if (!key.startsWith(X_POST_PREFIX)) return undefined;
  const id = key.slice(X_POST_PREFIX.length);
  return STATUS_ID.test(id) ? id : undefined;
};

/** A key that is the sha256 hex of its content. */
export const isContentHashKey = (key: string): boolean => /^[0-9a-f]{64}$/.test(key);

/** Every key a badge lookup may ask for. */
export const isProofKey = (key: unknown): key is string =>
  typeof key === 'string' && (isContentHashKey(key) || xPostIdFromKey(key) !== undefined);

const optional = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;

/** The JSON value written to the KV token: AuthSig's six fields first, our extras after, undefined ones left out. */
export const encodeProofValue = (v: ProofValue): string => {
  const out: Record<string, string> = {
    signature: v.signature,
    publicKey: v.publicKey,
    signedAt: v.signedAt,
    protocol: v.protocol,
  };
  if (v.content !== undefined) out.content = v.content;
  if (v.contentHash !== undefined) out.contentHash = v.contentHash;
  for (const k of ['signer', 'pageUrl', 'platform', 'postId', 'authorHandle'] as const) {
    const x = v[k];
    if (x !== undefined) out[k] = x;
  }
  return JSON.stringify(out);
};

/**
 * Parse a token value. Shape checks only (hex lengths, key form, date); the signature is checked by verify.ts.
 * Anything malformed is null, never thrown: overlay data is untrusted.
 */
export const decodeProofValue = (raw: unknown): ProofValue | null => {
  if (typeof raw !== 'string' || raw.length > 4 * MAX_CONTENT_CHARS + 4096) return null;
  let v: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    v = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const { signature, publicKey, signedAt, protocol } = v;
  if (typeof signature !== 'string' || signature.length < 16 || signature.length > 146 || signature.length % 2)
    return null;
  if (!HEX.test(signature)) return null;
  if (typeof publicKey !== 'string' || !/^0[23][0-9a-f]{64}$/i.test(publicKey)) return null;
  if (typeof signedAt !== 'string' || signedAt.length > 40 || Number.isNaN(Date.parse(signedAt))) return null;
  if (typeof protocol !== 'string' || protocol.length > 40) return null;
  const out: ProofValue = {
    signature: signature.toLowerCase(),
    publicKey: publicKey.toLowerCase(),
    signedAt,
    protocol,
  };
  if (v.content !== undefined) {
    if (typeof v.content !== 'string' || v.content.length > MAX_CONTENT_CHARS) return null;
    out.content = v.content;
  }
  if (v.contentHash !== undefined) {
    if (typeof v.contentHash !== 'string' || !/^[0-9a-f]{64}$/i.test(v.contentHash)) return null;
    out.contentHash = v.contentHash.toLowerCase();
  }
  const signer = optional(v.signer, 60);
  if (signer && SIGNER_RE.test(signer.toLowerCase())) out.signer = signer.toLowerCase();
  const pageUrl = optional(v.pageUrl, 2048);
  if (pageUrl && /^https:\/\//i.test(pageUrl)) out.pageUrl = pageUrl;
  const platform = optional(v.platform, 100);
  if (platform) out.platform = platform;
  const postId = optional(v.postId, 200);
  if (postId) out.postId = postId;
  const authorHandle = optional(v.authorHandle, 100);
  if (authorHandle) out.authorHandle = authorHandle;
  return out;
};

/** Where a proof is stored: AuthSig's x-post key for a post on X, else the content hash. */
export const storageKeyFor = (p: { xStatusId?: string; contentHash: string }): string =>
  (p.xStatusId && xPostKey(p.xStatusId)) || p.contentHash;

/** "02a0647…a220": a key short enough for a badge. */
export const shortKey = (publicKey: string): string => `${publicKey.slice(0, 7)}…${publicKey.slice(-4)}`;

/** A proof as the background hands it to the content script, after verify.ts accepted it. */
export type VerifiedProof = {
  key: string;
  /** The text the signature covers (from the record, or the page text whose hash is the key). */
  content: string;
  publicKey: string;
  signedAt: string;
  /** txid.vout of the KV token, when the overlay returned it. */
  outpoint?: string;
  /** The $name the record claims (unchecked). */
  claimedName?: string;
  /** "$alice", only after the paymail check passed (names.ts). */
  name?: string;
  /** Who wrote the record: bWalletX (has our fields) or another AuthSig client. */
  source: 'bwalletx' | 'authsig';
  pageUrl?: string;
  platform?: string;
};

/** The txid of a proof's token, for the "on-chain record" link. */
export const proofTxid = (p: Pick<VerifiedProof, 'outpoint'>): string | undefined => {
  const txid = p.outpoint?.split('.')[0];
  return txid && /^[0-9a-f]{64}$/i.test(txid) ? txid.toLowerCase() : undefined;
};
