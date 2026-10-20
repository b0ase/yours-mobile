/**
 * Extension passkey hand-off (owner, 20 Oct 2026). VITE_SEEDLESS=1 only. Design + threat model:
 * notes/extension-passkey-handoff.md.
 *
 * The extension cannot use the bwalletx.com passkey (its origin is chrome-extension://), so it sends the person to
 * web.bwalletx.com, where the passkey opens the sealed 12 words, and the web page hands them straight back with
 * one local browser message (chrome.runtime.sendMessage to the extension). No server, no relay.
 *
 *   1. The extension makes a request (random nonce, 2 minutes, single use) and opens the fixed web URL with it.
 *   2. The web page opens the backup with the passkey, makes a 6-digit code and shows it, and sends ONE message:
 *      { t, n: nonce, words, name?, proof: HMAC(nonce, "bwalletx-ext-handoff|<nonce>|<code>") }.
 *   3. The extension background accepts it only from the exact web origin, for the live nonce, and parks it as
 *      "received". It never restores by itself.
 *   4. The person types the code (shown only on the web page) into the extension. A right code releases the words
 *      to the Restore form; a WRONG code burns the request (one attempt). Either way the parked words are erased.
 *
 * This file is pure (no chrome.* calls) so every rule can be tested. The browser glue is extHandoffStore.ts.
 */
import { b64url } from './seedBackup';

/** Compile-time switch, written literally so Vite drops every hand-off path from a build without VITE_SEEDLESS=1. */
export const HANDOFF_ENABLED: boolean = import.meta.env.VITE_SEEDLESS === '1';

/** The only page allowed to hand a wallet to the extension. Exact match, never a wildcard over *.bwalletx.com. */
export const HANDOFF_WEB_ORIGIN = 'https://web.bwalletx.com';
/** The extension's id, fixed by the manifest key (scripts/extension-key.pub.txt). The web page only talks to this id. */
export const HANDOFF_EXT_ID = 'bombmmcjghjdlbmcclnhjodgcelnehgl';
export const HANDOFF_TYPE = 'bwalletx-ext-handoff';
export const HANDOFF_LIFETIME_MS = 120_000;
export const HANDOFF_CODE_DIGITS = 6;
const MAX_NAME = 64;

const enc = new TextEncoder();

export type HandoffState = 'waiting' | 'received';
/** Kept in chrome.storage.session (memory only, never written to disk). */
export type HandoffSession = {
  nonce: string;
  exp: number;
  state: HandoffState;
  /** Only once received. */
  words?: string;
  name?: string;
  proof?: string;
};

export type HandoffMessage = { t: typeof HANDOFF_TYPE; n: string; words: string; name?: string; proof: string };

/** A fresh request: 128-bit nonce, 2-minute life. */
export const newHandoffSession = (now = Date.now()): HandoffSession => ({
  nonce: b64url(crypto.getRandomValues(new Uint8Array(16))),
  exp: now + HANDOFF_LIFETIME_MS,
  state: 'waiting',
});

/** The web page the extension opens. Built here from constants plus the nonce: nothing else is ever interpolated. */
export const handoffUrl = (nonce: string, extId = HANDOFF_EXT_ID): string =>
  `${HANDOFF_WEB_ORIGIN}/restore?passkey=1&ext=${encodeURIComponent(extId)}&n=${encodeURIComponent(nonce)}`;

/** 6 random digits, uniform (no modulo bias). */
export const newHandoffCode = (): string => {
  const limit = 4_294_967_296 - (4_294_967_296 % 10 ** HANDOFF_CODE_DIGITS);
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0] >= limit);
  return String(buf[0] % 10 ** HANDOFF_CODE_DIGITS).padStart(HANDOFF_CODE_DIGITS, '0');
};

/** Strip spaces/dashes people type or paste; the result must be exactly the right number of digits or ''. */
export const normaliseHandoffCode = (raw: string): string => {
  const d = String(raw ?? '').replace(/[\s-]/g, '');
  return new RegExp(`^\\d{${HANDOFF_CODE_DIGITS}}$`).test(d) ? d : '';
};

export const handoffProof = async (nonce: string, code: string): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', enc.encode(nonce), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const m = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, enc.encode(`${HANDOFF_TYPE}|${nonce}|${normaliseHandoffCode(code)}`)),
  );
  return b64url(m);
};

/** Compare two strings without an early exit on the first difference. */
export const sameText = (a: string, b: string): boolean => {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
};

export const isHandoffOrigin = (origin: unknown, allowLocal = false): boolean =>
  origin === HANDOFF_WEB_ORIGIN ||
  (allowLocal && /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(String(origin)));

/** Same cleaning as the Restore form (lower case, drop numbering) so a 12/24 word check means the same thing. */
export const cleanWords = (raw: string): string =>
  String(raw ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');

/** Null unless the message is exactly the one allowed shape. Returns a cleaned copy, never the raw object. */
export const parseHandoffMessage = (m: unknown): HandoffMessage | null => {
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  if (o.t !== HANDOFF_TYPE || typeof o.n !== 'string' || typeof o.words !== 'string' || typeof o.proof !== 'string')
    return null;
  if (!/^[A-Za-z0-9_-]{22}$/.test(o.n) || !/^[A-Za-z0-9_-]{43}$/.test(o.proof)) return null;
  if (o.words.length > 400) return null;
  const words = cleanWords(o.words);
  const count = words ? words.split(' ').length : 0;
  if (count !== 12 && count !== 24) return null;
  if (!/^[a-z ]+$/.test(words)) return null;
  let name: string | undefined;
  if (o.name !== undefined) {
    if (typeof o.name !== 'string' || o.name.length > MAX_NAME) return null;
    name = o.name.trim() || undefined;
  }
  return { t: HANDOFF_TYPE, n: o.n, words, name, proof: o.proof };
};

export type ReceiveResult = { ok: true; session: HandoffSession } | { ok: false; session: HandoffSession | null };

/**
 * The background's side: may this message, from this sender origin, fill the waiting request?
 * Every refusal looks the same to the caller. A request is only changed by a message that carries ITS nonce, so a
 * stray message can't burn it; expiry and "already received" refuse without changing it.
 */
export const receiveHandoff = (
  session: HandoffSession | null,
  senderOrigin: unknown,
  message: unknown,
  now = Date.now(),
  allowLocal = false,
): ReceiveResult => {
  const refuse = { ok: false, session } as const;
  if (!session || !isHandoffOrigin(senderOrigin, allowLocal)) return refuse;
  const msg = parseHandoffMessage(message);
  if (!msg || !sameText(msg.n, session.nonce)) return refuse;
  if (now > session.exp || session.state !== 'waiting') return refuse;
  return {
    ok: true,
    session: { ...session, state: 'received', words: msg.words, name: msg.name, proof: msg.proof },
  };
};

export type ConfirmResult =
  | { ok: true; words: string; name?: string }
  | { ok: false; reason: 'none' | 'expired' | 'not-received' | 'bad-code' | 'wrong-code' };

/**
 * The popup's side: the person typed a code. Returns the words on a right code. `burn` says the stored request must
 * be erased now (always after a wrong code or expiry, and after success): one attempt only. 'not-received' (the web
 * step isn't finished) and a malformed code (bad-code) do NOT burn, because nothing was guessed.
 */
export const confirmHandoff = async (
  session: HandoffSession | null,
  typed: string,
  now = Date.now(),
): Promise<ConfirmResult & { burn: boolean }> => {
  if (!session) return { ok: false, reason: 'none', burn: false };
  if (now > session.exp) return { ok: false, reason: 'expired', burn: true };
  if (session.state !== 'received' || !session.words || !session.proof)
    return { ok: false, reason: 'not-received', burn: false };
  const code = normaliseHandoffCode(typed);
  if (!code) return { ok: false, reason: 'bad-code', burn: false };
  const ok = sameText(await handoffProof(session.nonce, code), session.proof);
  if (!ok) return { ok: false, reason: 'wrong-code', burn: true };
  return { ok: true, words: session.words, name: session.name, burn: true };
};

/** What the web page sends (it keeps the code to show; the proof is all the extension sees). */
export const buildHandoffMessage = async (
  nonce: string,
  code: string,
  words: string,
  name?: string,
): Promise<HandoffMessage> => ({
  t: HANDOFF_TYPE,
  n: nonce,
  words: cleanWords(words),
  ...(name ? { name: name.slice(0, MAX_NAME) } : {}),
  proof: await handoffProof(nonce, code),
});

/** The web page only runs the hand-off for a well-formed nonce and OUR extension id. */
export const parseHandoffSearch = (search: string): { nonce: string } | null => {
  const q = new URLSearchParams(search);
  const n = q.get('n') ?? '';
  if (q.get('ext') !== HANDOFF_EXT_ID || !/^[A-Za-z0-9_-]{22}$/.test(n)) return null;
  return { nonce: n };
};
