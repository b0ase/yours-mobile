/**
 * Twetch post format and signatures (pure: no storage, no network). Research notes 27 Oct 2026, decoded from live
 * posts in api.twetch.com /v1/feed/latest:
 *
 *   OP_FALSE OP_RETURN
 *     19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut <text> text/markdown UTF-8 |
 *     1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5 SET app twetch type post [reply <txid>] [files <json>] [ts <ms>] |
 *     15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva BITCOIN_ECDSA <address> <base64 compact BSM signature>
 *
 * AIP signing payload (checked against a live Twetch post, tx 03686ac2…5f0b, in twetchPost.test.ts, and against
 * @1sat/templates' AIP.validateAIP, which follows go-templates / bmap): the byte 0x6a (OP_RETURN) followed by the
 * raw bytes of every push before the AIP prefix, the two '|' pushes included, with no separators or length bytes.
 * The signature is a Bitcoin Signed Message (BSM) over those bytes, compact and base64, by the key whose address is
 * the AIP address (the user's Twetch publicKey).
 *
 * Nothing is paid to Twetch: the post output carries 0 sats; the only cost is the miner fee.
 */
import { BSM, BigNumber, PrivateKey, PublicKey, Signature, Utils } from '@bsv/sdk';

export const B_PREFIX = '19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut';
export const MAP_PREFIX = '1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5';
export const AIP_PREFIX = '15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva';
export const AIP_ALGORITHM = 'BITCOIN_ECDSA';

/** Caps on what a site may ask the wallet to post. */
export const TEXT_MAX = 25_000;
export const FILES_MAX = 10;
const FILE_REF = /^b:\/\/[0-9a-f]{64}(@\d{1,4})?$/;
const TXID = /^[0-9a-f]{64}$/;
// Control characters other than tab / newline / CR, and bidi overrides that could disguise the preview.
// eslint-disable-next-line no-control-regex
const BAD_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export type PostInput = { text: string; replyTxid?: string; files?: string[] };

const obj = (p: unknown): Record<string, unknown> | null =>
  p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null;

/** Check twetch.buildPost params. A string is the reason they were refused. */
export const validatePostParams = (params: unknown): PostInput | string => {
  const p = obj(params);
  if (!p) return 'params must be an object';
  for (const k of Object.keys(p)) if (k !== 'text' && k !== 'replyTxid' && k !== 'files') return `unknown field ${k}`;
  const { text, replyTxid, files } = p;
  if (typeof text !== 'string' || !text.trim()) return 'text is required';
  if (text.length > TEXT_MAX) return `text must be at most ${TEXT_MAX} characters`;
  if (BAD_TEXT.test(text) || LONE_SURROGATE.test(text)) return 'text contains characters that are not allowed';
  const out: PostInput = { text };
  if (replyTxid !== undefined) {
    if (typeof replyTxid !== 'string' || !TXID.test(replyTxid)) return 'replyTxid must be 64 lower-case hex';
    out.replyTxid = replyTxid;
  }
  if (files !== undefined) {
    if (!Array.isArray(files) || files.length > FILES_MAX) return `files must be a list of at most ${FILES_MAX}`;
    if (!files.every((f) => typeof f === 'string' && FILE_REF.test(f)))
      return 'each file must be a b://<txid>[@vout] reference';
    if (files.length) out.files = files as string[];
  }
  return out;
};

/** MAP SET fields, in the order Twetch's own client writes them. */
export const mapFields = (input: PostInput, ts?: number): string[] => [
  'SET',
  'app',
  'twetch',
  'type',
  'post',
  ...(input.replyTxid ? ['reply', input.replyTxid] : []),
  ...(input.files?.length ? ['files', JSON.stringify(input.files)] : []),
  ...(ts !== undefined ? ['ts', String(ts)] : []),
];

const utf8 = (s: string) => Utils.toArray(s, 'utf8');

/** Every push before the AIP prefix: B fields | MAP fields |. */
export const dataPushes = (input: PostInput, ts?: number): number[][] =>
  [B_PREFIX, input.text, 'text/markdown', 'UTF-8', '|', MAP_PREFIX, ...mapFields(input, ts), '|'].map(utf8);

/** The bytes AIP signs: OP_RETURN (0x6a) then each push's raw bytes. */
export const aipMessage = (pushes: number[][]): number[] => [0x6a, ...pushes.flat()];

/** Minimal push encoding (what @bsv/sdk Script.writeBin writes). */
const push = (d: number[]): number[] => {
  const n = d.length;
  if (n === 0) return [0x00];
  if (n < 0x4c) return [n, ...d];
  if (n < 0x100) return [0x4c, n, ...d];
  if (n < 0x10000) return [0x4d, n & 0xff, n >> 8, ...d];
  return [0x4e, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff, ...d];
};

/** OP_FALSE OP_RETURN <pushes> AIP BITCOIN_ECDSA <address> <signature>, as hex. */
export const assemblePostScript = (pushes: number[][], address: string, signatureB64: string): string =>
  Utils.toHex([
    0x00,
    0x6a,
    ...[...pushes, utf8(AIP_PREFIX), utf8(AIP_ALGORITHM), utf8(address), utf8(signatureB64)].flatMap(push),
  ]);

/** BSM signature, compact + base64 (the form AIP and Twetch's login use). */
export const bsmSign = (message: number[], key: PrivateKey): string => BSM.sign(message, key, 'base64') as string;

/** Does `signatureB64` sign `message` (BSM) for `address`? */
export const bsmVerifyAddress = (message: number[], signatureB64: string, address: string): boolean => {
  let sig: Signature;
  try {
    sig = Signature.fromCompact(signatureB64, 'base64');
  } catch {
    return false;
  }
  const hash = new BigNumber(BSM.magicHash(message));
  for (let r = 0; r < 4; r++) {
    try {
      const pk: PublicKey = sig.RecoverPublicKey(r, hash);
      if (pk.toAddress() === address && BSM.verify(message, sig, pk)) return true;
    } catch {
      /* next recovery id */
    }
  }
  return false;
};

/** The post's OP_RETURN script (hex), AIP-signed by the Twetch key. */
export const buildPostScript = (input: PostInput, key: PrivateKey, ts?: number): string => {
  const pushes = dataPushes(input, ts);
  const address = key.toPublicKey().toAddress();
  return assemblePostScript(pushes, address, bsmSign(aipMessage(pushes), key));
};

/* ---------- login ---------- */

/** Twetch's login challenge, as POST /v1/auth/login-challenge returns it (27 Oct 2026). */
export const CHALLENGE_RE = /^twetch-login:[0-9a-f]{64}:(\d{13})$/;
export const CHALLENGE_MAX = 100;
/** Challenges are fresh: refuse one stamped more than this far from now. */
export const CHALLENGE_SKEW_MS = 10 * 60 * 1000;

/** The challenge, or the reason it is refused. Only Twetch's exact format signs, so this is never a blank cheque. */
export const validateChallenge = (params: unknown, now = Date.now()): string | { challenge: string } => {
  const p = obj(params);
  if (!p) return 'params must be an object';
  const c = p.challenge;
  if (typeof c !== 'string' || !c || c.length > CHALLENGE_MAX) return 'challenge missing or too long';
  const m = CHALLENGE_RE.exec(c);
  if (!m) return 'not a Twetch login challenge';
  if (Math.abs(Number(m[1]) - now) > CHALLENGE_SKEW_MS) return 'challenge expired';
  return { challenge: c };
};

/** BSM signature of the challenge text by the Twetch key. */
export const signChallenge = (challenge: string, key: PrivateKey): string => bsmSign(utf8(challenge), key);

/* ---------- what the sheet shows ---------- */

export const PREVIEW_MAX = 280;
/** The post text as the sheet shows it: whole up to PREVIEW_MAX characters, then cut with an ellipsis. */
export const previewText = (text: string): string =>
  text.length <= PREVIEW_MAX ? text : `${Array.from(text).slice(0, PREVIEW_MAX).join('')}…`;

/** Miner fee in dollars, e.g. "$0.0004" / "under $0.01" / "$0.03"; sats when there's no rate. */
export const feeLabel = (sats: number, bsvUsd: number): string => {
  if (!(bsvUsd > 0)) return `${sats} sats`;
  const usd = (sats / 1e8) * bsvUsd;
  if (usd < 0.01) return 'under $0.01';
  return `$${usd.toFixed(2)}`;
};

export const loginTitle = (handle: string) => `Sign in to Twetch as ${handle}?`;
export const postTitle = (handle: string, reply: boolean) => `${reply ? 'Reply' : 'Post'} on Twetch as ${handle}?`;
