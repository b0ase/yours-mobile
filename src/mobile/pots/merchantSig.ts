/**
 * Signed subscription requests (docs/SUBSCRIBE-API.md › Signing). Every `subscribe` call must carry a Bitcoin Signed
 * Message (BSM) signature by the merchant's identity key over one canonical string:
 *
 *   JSON.stringify(["bwx-subscribe-v1", origin, payTo, usdPerMonth.toFixed(2), "month", merchantName, description,
 *                   nonce, expiresAt])
 *
 * `origin` is the origin the wallet saw the request come from (frame MessageEvent, native WebView, or Chrome's
 * sender), never a value the page supplies, so a request signed for one site can't be replayed from another.
 * Requests expire (at most MAX_LIFETIME_MS ahead) and each nonce is accepted once per merchant key.
 *
 * Pure apart from the used-nonce store (localStorage).
 */
import { BSM, PrivateKey, PublicKey, Signature, Utils } from '@bsv/sdk';

export const SIG_VERSION = 'bwx-subscribe-v1';
/** The longest a signed request may stay valid. */
export const MAX_LIFETIME_MS = 15 * 60_000;
/** Clock skew allowed between the merchant's server and this device. */
const SKEW_MS = 60_000;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const KEY_RE = /^0[23][0-9a-f]{64}$/i;
const NONCES = 'bwx.subNonces.v1';
const MAX_NONCES = 2000;

export type SignedFields = {
  origin: string;
  payTo: string;
  usdPerMonth: number;
  merchantName: string;
  description: string;
  nonce: string;
  expiresAt: number;
};

export type MerchantProof = { merchantKey: string; nonce: string; expiresAt: number; signature: string };

/** The exact string a merchant signs. */
export const canonicalSubscribe = (f: SignedFields): string =>
  JSON.stringify([
    SIG_VERSION,
    f.origin,
    f.payTo,
    f.usdPerMonth.toFixed(2),
    'month',
    f.merchantName,
    f.description,
    f.nonce,
    f.expiresAt,
  ]);

class SigError extends Error {}
const fail = (m: string): never => {
  throw new SigError(m);
};

/** Pulls merchantKey / nonce / expiresAt / signature out of the args, or throws naming what's wrong. */
export const parseProof = (args: Record<string, unknown>): MerchantProof => {
  const { merchantKey, nonce, expiresAt, signature } = args;
  if (merchantKey === undefined && signature === undefined)
    fail('Unsigned request: merchantKey and signature are required');
  if (typeof merchantKey !== 'string' || !KEY_RE.test(merchantKey))
    fail('merchantKey must be a compressed public key (66 hex)');
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) fail('nonce must be 16-64 characters of A-Z a-z 0-9 _ -');
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)) fail('expiresAt must be a time in ms');
  if (typeof signature !== 'string' || signature.length < 80 || signature.length > 100)
    fail('signature must be a base64 BSM signature');
  return {
    merchantKey: (merchantKey as string).toLowerCase(),
    nonce: nonce as string,
    expiresAt: expiresAt as number,
    signature: signature as string,
  };
};

type NonceMap = Record<string, number>;
const readNonces = (): NonceMap => {
  try {
    const v = localStorage.getItem(NONCES);
    const m = v ? (JSON.parse(v) as unknown) : {};
    return m && typeof m === 'object' && !Array.isArray(m) ? (m as NonceMap) : {};
  } catch {
    return {};
  }
};
const writeNonces = (m: NonceMap) => {
  try {
    localStorage.setItem(NONCES, JSON.stringify(m));
  } catch {
    fail('Can’t record this request, so it can’t be accepted');
  }
};

/**
 * Verifies a merchant's signed request for `fields` (origin = the real sender origin) and burns its nonce. Throws on
 * an unsigned, malformed, badly signed, expired, too-long-lived or replayed request. Returns the merchant key.
 */
export const verifyMerchant = (fields: Omit<SignedFields, 'nonce' | 'expiresAt'>, p: MerchantProof, now: number) => {
  if (p.expiresAt <= now) fail('This request has expired');
  if (p.expiresAt > now + MAX_LIFETIME_MS + SKEW_MS) fail('expiresAt is too far ahead (15 minutes at most)');
  let ok = false;
  try {
    const msg = Utils.toArray(canonicalSubscribe({ ...fields, nonce: p.nonce, expiresAt: p.expiresAt }), 'utf8');
    ok = BSM.verify(msg, Signature.fromCompact(p.signature, 'base64'), PublicKey.fromString(p.merchantKey));
  } catch {
    ok = false;
  }
  if (!ok) fail('The merchant signature doesn’t match this request');
  // Replay: one use per merchant key + nonce, kept until it expires.
  const all = readNonces();
  const live: NonceMap = {};
  for (const [k, exp] of Object.entries(all)) if (typeof exp === 'number' && exp > now) live[k] = exp;
  const key = `${p.merchantKey}:${p.nonce}`;
  if (live[key]) fail('This request was already used');
  // Never forget a live nonce to make room (that would reopen replays): refuse until some expire.
  if (Object.keys(live).length >= MAX_NONCES) fail('Too many subscription requests, try again in a few minutes');
  live[key] = p.expiresAt + SKEW_MS;
  writeNonces(live);
  return p.merchantKey;
};

/** Short, readable form of a merchant key for the sheet: 02ab12…9f0e. */
export const keyFingerprint = (k: string) => `${k.slice(0, 6)}…${k.slice(-4)}`;

/**
 * Merchant side (server only, never in a page): signs a request for `origin`. Returns the four fields to add to the
 * `subscribe` args. Copy of the recipe in docs/SUBSCRIBE-API.md › Signing.
 */
export const signSubscribeRequest = (
  f: Omit<SignedFields, 'nonce' | 'expiresAt'>,
  merchantWif: string,
  now = Date.now(),
  nonce = Utils.toBase64(PrivateKey.fromRandom().toArray().slice(0, 18)).replace(/[+/=]/g, (c) =>
    c === '+' ? '-' : c === '/' ? '_' : '',
  ),
): MerchantProof => {
  const key = PrivateKey.fromWif(merchantWif);
  const expiresAt = now + 5 * 60_000;
  const msg = Utils.toArray(canonicalSubscribe({ ...f, nonce, expiresAt }), 'utf8');
  return {
    merchantKey: key.toPublicKey().toString(),
    nonce,
    expiresAt,
    signature: BSM.sign(msg, key, 'base64') as string,
  };
};
