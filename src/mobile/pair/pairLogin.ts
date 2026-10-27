/**
 * One tap to sign in through a paired phone (owner, 27 Oct 2026). A paired site's "Sign in with bWalletX" sends, in
 * order: isAuthenticated, waitForAuthentication, getPublicKey({ identityKey: true }), createSignature over its login
 * challenge, and (first sign-in in that browser only) a BSM proof of the chat key over the same text. Before this,
 * each went through the permission manager on its own: up to 4–5 sheets on a first sign-in, and none at all once the
 * login protocol had been granted (a silent sign-in). Now:
 *
 * - The login signature ALWAYS shows one sheet, "Sign in to <host> as $handle?", and is never remembered. It is
 *   recognised by its content, not by a label the site chose: protocol [2, 'bwallet sign in'], counterparty 'anyone',
 *   and data that is exactly bit-sign's challenge text (bit-sign src/lib/bwallet-login.ts bwalletLoginMessage) for
 *   THIS pairing's verified origin, with keyID = its nonce and an expiry in the next few minutes.
 * - getPublicKey({ identityKey: true }) is answered for a pairing the user already Connected, with no sheet: Connect is
 *   the consent to share who you are with that site.
 * - The BSM chat-key proof is answered with no sheet only when its hash is the BSM hash of the very text the user
 *   just approved on the sign-in sheet, once, within a short window; its getPublicKey(forSelf) likewise.
 *
 * Everything else (spends, other signatures, other protocols) still goes through the normal approval path untouched.
 * Signing here uses the wallet's own context: BRC-42 keys depend on protocol, keyID and counterparty, never on the
 * originator, so the signature is the same one the site would have got through the permission manager, and no grant
 * is written that could make the next sign-in silent.
 */
import { BSM, Utils } from '@bsv/sdk';
import { MESSAGE_SIGNING_PROTOCOL } from '@1sat/types';
import { USER_DENIED_CODE, USER_DENIED_MESSAGE } from '../../services/userDenied';

export const LOGIN_PROTOCOL_NAME = 'bwallet sign in';
/** bit-sign issues two-minute nonces; allow a little clock skew, refuse anything further out. */
export const LOGIN_MAX_AHEAD_MS = 10 * 60 * 1000;
/** How long after the sign-in sheet the matching chat-key proof may follow without a sheet. */
export const BSM_FOLLOW_MS = 2 * 60 * 1000;

export type LoginRequest = { origin: string; host: string; nonce: string; message: string };
type Sig = { protocolID?: unknown; keyID?: unknown; counterparty?: unknown; data?: unknown; hashToDirectlySign?: unknown };

const obj = (p: unknown): Record<string, unknown> | null =>
  p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null;

const sameProtocol = (p: unknown, want: readonly [number, string]) =>
  Array.isArray(p) && p.length === 2 && p[0] === want[0] && p[1] === want[1];

const bytes = (v: unknown): number[] | null =>
  Array.isArray(v) && v.every((b) => Number.isInteger(b) && b >= 0 && b <= 255) ? (v as number[]) : null;

/** The exact challenge text bit-sign builds (src/lib/bwallet-login.ts bwalletLoginMessage). */
export const loginMessage = (origin: string, nonce: string, expiresAt: string) =>
  [
    `Sign in to ${new URL(origin).host} with bWallet`,
    '',
    'This proves you hold this wallet. It does not spend anything.',
    '',
    `Origin: ${origin}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt}`,
  ].join('\n');

/** A createSignature that names the login protocol at all (valid or not). */
export const isLoginProtocolCall = (action: string, params: unknown) =>
  action === 'createSignature' && sameProtocol(obj(params)?.protocolID, [2, LOGIN_PROTOCOL_NAME]);

/**
 * The login challenge for `sessionOrigin`, or the reason it is refused. Only a byte-for-byte match of the challenge
 * text for this pairing's own origin counts; anything else under the login protocol is refused outright.
 */
export const parseLoginRequest = (params: unknown, sessionOrigin: string, now = Date.now()): LoginRequest | string => {
  const p = obj(params) as Sig | null;
  if (!p || !sameProtocol(p.protocolID, [2, LOGIN_PROTOCOL_NAME])) return 'not a sign-in request';
  if (p.counterparty !== 'anyone') return 'sign-in must use counterparty anyone';
  if (p.hashToDirectlySign !== undefined) return 'sign-in must sign its text, not a hash';
  if (typeof p.keyID !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(p.keyID)) return 'bad sign-in nonce';
  const data = bytes(p.data);
  if (!data) return 'sign-in text missing';
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(data));
  } catch {
    return 'sign-in text is not UTF-8';
  }
  let origin: string;
  try {
    origin = new URL(sessionOrigin).origin;
  } catch {
    return 'bad paired origin';
  }
  const m = /\nExpires: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/.exec(text);
  if (!m) return 'sign-in text not recognised';
  const exp = Date.parse(m[1]);
  if (!(exp > now) || exp - now > LOGIN_MAX_AHEAD_MS) return 'sign-in request expired';
  if (text !== loginMessage(origin, p.keyID, m[1])) return 'sign-in text does not match this site';
  return { origin, host: new URL(origin).host, nonce: p.keyID, message: text };
};

/** getPublicKey({ identityKey: true }) and nothing that changes what is returned. */
export const isIdentityKeyCall = (action: string, params: unknown) => {
  const p = obj(params);
  if (action !== 'getPublicKey' || !p || p.identityKey !== true) return false;
  return Object.keys(p).every((k) => k === 'identityKey' || k === 'reason' || (k === 'privileged' && !p.privileged));
};

/** The chat-key proof: what @1sat/actions signBsm sends (createSignature, then getPublicKey forSelf). */
const isBsmSign = (action: string, p: Record<string, unknown> | null) =>
  action === 'createSignature' &&
  !!p &&
  sameProtocol(p.protocolID, MESSAGE_SIGNING_PROTOCOL as [number, string]) &&
  p.keyID === 'identity' &&
  p.counterparty === 'self' &&
  p.data === undefined &&
  !p.privileged;
const isBsmKey = (action: string, p: Record<string, unknown> | null) =>
  action === 'getPublicKey' &&
  !!p &&
  sameProtocol(p.protocolID, MESSAGE_SIGNING_PROTOCOL as [number, string]) &&
  p.keyID === 'identity' &&
  p.forSelf === true &&
  !p.identityKey &&
  !p.privileged &&
  (p.counterparty === undefined || p.counterparty === 'self');

/**
 * Per pairing channel: the text the user approved on the sign-in sheet, so the chat-key proof over that same text
 * (and only that, once) needs no second sheet.
 */
type Follow = { hash: string; at: number; signed: boolean; keyGiven: boolean };
const follows = new Map<string, Follow>();

export const noteApprovedLogin = (channel: string, message: string, now = Date.now()) =>
  follows.set(channel, {
    hash: Utils.toHex(BSM.magicHash(Utils.toArray(message, 'utf8'))),
    at: now,
    signed: false,
    keyGiven: false,
  });

/** Whether this call is the approved login's chat-key proof (consumes it). */
export const takeBsmFollowUp = (channel: string, action: string, params: unknown, now = Date.now()): boolean => {
  const f = follows.get(channel);
  if (!f || now - f.at > BSM_FOLLOW_MS) return false;
  const p = obj(params);
  if (isBsmSign(action, p) && !f.signed) {
    const h = bytes(p!.hashToDirectlySign);
    if (!h || Utils.toHex(h) !== f.hash) return false;
    f.signed = true;
    return true;
  }
  if (isBsmKey(action, p) && f.signed && !f.keyGiven) {
    f.keyGiven = true;
    follows.delete(channel);
    return true;
  }
  return false;
};

export const forgetLogin = (channel: string) => void follows.delete(channel);

/* ---------- the sheet ---------- */

export type LoginAsk = { host: string; handle: string; proven: boolean };
type Pending = { ask: LoginAsk; resolve: (ok: boolean) => void };
let pending: Pending[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

/** Queue a sign-in sheet (one at a time, oldest first); resolves true on Approve. */
export const askLogin = (ask: LoginAsk): Promise<boolean> =>
  new Promise((resolve) => {
    pending.push({ ask, resolve });
    emit();
  });
export const currentLogin = (): LoginAsk | null => pending[0]?.ask ?? null;
export const answerLogin = (ok: boolean) => {
  const [p, ...rest] = pending;
  if (!p) return;
  pending = rest;
  p.resolve(ok);
  emit();
};
export const onLoginAsk = (f: () => void) => {
  listeners.add(f);
  return () => void listeners.delete(f);
};

/* ---------- superseded Connect cards ---------- */

/**
 * Open Connect cards by origin. A site that got its sign-in through another (stored) pairing no longer needs the
 * fresh QR it also showed, so its card closes instead of staying on screen.
 */
const connectCards = new Map<symbol, { origin: string; close: () => void }>();
export const watchConnectCard = (origin: string, close: () => void) => {
  const id = Symbol('connect');
  connectCards.set(id, { origin, close });
  return () => void connectCards.delete(id);
};
export const closeConnectCardsFor = (origin: string) => {
  for (const [id, c] of [...connectCards])
    if (c.origin === origin) {
      connectCards.delete(id);
      c.close();
    }
};

/* ---------- one paired call ---------- */

type WalletLike = {
  createSignature: (a: never) => Promise<{ signature: number[] }>;
  getPublicKey: (a: never) => Promise<{ publicKey: string }>;
};
export type PairLoginDeps = {
  /** The wallet's own context (unlocked), or undefined while locked. */
  wallet: WalletLike | undefined;
  /** The account's name to show ("$b0asex"); '' when it has none. */
  handle: () => string;
  /** The pairing proved its origin (PairSheet shows "claims to be" otherwise). */
  proven: boolean;
  ask?: (a: LoginAsk) => Promise<boolean>;
  /** A sign-in went through for this origin: close any other Connect card it left open. */
  onSignedIn?: (origin: string) => void;
};
export type PairLoginReply = { result: unknown } | { error: { code: string; message: string } };

const LOCKED = { error: { code: 'LOCKED', message: 'bWalletX is locked. Unlock it on your phone.' } };

/**
 * A paired, Connected site's call, if it is part of a sign-in (see the top of this file); null for every other call,
 * which goes the normal way. `channel` is the pairing's own channel id, `sessionOrigin` its verified origin.
 */
export async function handlePairLoginCall(
  channel: string,
  sessionOrigin: string,
  action: string,
  params: unknown,
  deps: PairLoginDeps,
  now = Date.now(),
): Promise<PairLoginReply | null> {
  if (isLoginProtocolCall(action, params)) {
    const req = parseLoginRequest(params, sessionOrigin, now);
    if (typeof req === 'string') return { error: { code: 'REJECTED', message: req } };
    if (!deps.wallet) return LOCKED;
    const raw = deps.handle().trim();
    const handle = raw ? (raw.startsWith('$') ? raw : `$${raw}`) : '';
    const ok = await (deps.ask ?? askLogin)({ host: req.host, handle, proven: deps.proven });
    if (!ok) return { error: { code: USER_DENIED_CODE, message: USER_DENIED_MESSAGE } };
    const { signature } = await deps.wallet.createSignature({
      protocolID: [2, LOGIN_PROTOCOL_NAME],
      keyID: req.nonce,
      counterparty: 'anyone',
      data: Utils.toArray(req.message, 'utf8'),
    } as never);
    noteApprovedLogin(channel, req.message, now);
    deps.onSignedIn?.(req.origin);
    return { result: { signature } };
  }
  // Locked (no wallet context yet): the normal path, which asks to unlock as it always did.
  if (!deps.wallet) return null;
  if (isIdentityKeyCall(action, params)) {
    return { result: await deps.wallet.getPublicKey({ identityKey: true } as never) };
  }
  if (takeBsmFollowUp(channel, action, params, now)) {
    const p = params as Record<string, unknown>;
    if (action === 'createSignature')
      return {
        result: await deps.wallet.createSignature({
          protocolID: MESSAGE_SIGNING_PROTOCOL,
          keyID: 'identity',
          counterparty: 'self',
          hashToDirectlySign: p.hashToDirectlySign,
        } as never),
      };
    return {
      result: await deps.wallet.getPublicKey({
        protocolID: MESSAGE_SIGNING_PROTOCOL,
        keyID: 'identity',
        forSelf: true,
      } as never),
    };
  }
  return null;
}
