/**
 * Cross-site signature relay guard (payment-safety audit 24 Oct 2026, B1).
 *
 * BRC-42 keys depend on the protocol, key ID and counterparty, not on which site asked. So evil.com could ask
 * for a signature under good.com's login protocol, over a challenge it fetched from good.com, and replay it
 * there as the user. Changing key derivation would change every existing login key, so instead the wallet
 * reads the data it is asked to sign: when it is text that names the site it is meant for (a SIWE-style
 * "<host> wants you to sign in" or "<host> wallet login:" line, or a domain / origin / host / audience / uri / url /
 * site / callback / redirect field), that site must be the one
 * calling (or a parent/subdomain of it). Data that names no site is signed as before; free links inside content (a post with a URL) are not
 * treated as a binding, so signed posts keep working.
 *
 * The wallet's own servers are covered (ownBackendKeys.ts): a site can't sign under 'auth message signature' towards a
 * server the wallet itself signs in to (online storage, bMail).
 *
 * Not covered here: relaying a BRC-103 session itself to anyone else. evil.com can open a BRC-103 (AuthFetch) session with good.com's
 * server and ask the wallet to sign its messages; those frames name no site, and a signature under 'auth message
 * signature' verifies at any BRC-103 peer. Stopping that needs the peer's identity (the counterparty) tied to the
 * calling site, not a reading of the data.
 */

import { bareHost, scanSignData } from './signDataScan';
import { ownBackendRefusal } from './ownBackendKeys';
import { PendingSighashes } from './pendingSighash';

// The readers live in signDataScan.ts (review 13 Nov 2026); re-exported for existing callers and tests.
export { bareHost, boundHosts, normaliseKey } from './signDataScan';

/**
 * Equal hosts, or one a dot-boundary subdomain of the other (app.bchatx.com and bchatx.com). Siblings never
 * match: a.vercel.app / b.vercel.app, a.github.io / b.github.io and a.co.uk / b.co.uk are different sites.
 */
export const sameSite = (a: string, b: string) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

/** Largest `data` the guard reads (and so the largest an outside caller may ask to sign). */
export const MAX_SIGN_DATA = 64 * 1024;
export const UNCHECKABLE_REFUSAL = 'The wallet could not check which site this message is for';

const decodeText = (data: unknown): string | null => {
  if (!Array.isArray(data) || data.length === 0 || data.length > MAX_SIGN_DATA) return null;
  if (!data.every((b) => typeof b === 'number' && b >= 0 && b <= 255)) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(data as number[]));
    let printable = 0;
    for (const ch of text) if (ch >= ' ' || ch === '\n' || ch === '\r' || ch === '\t') printable++;
    return printable / text.length >= 0.9 ? text : null;
  } catch {
    return null;
  }
};

/**
 * Every site the data names (signDataScan.ts reads it as text, leniently, through encodings and AuthFetch frames), and
 * whether it was plain text. `exhausted`: crafted data needed more reading than the scan allows, so it can't be checked.
 */
const namedHosts = (data: unknown, args: object): { hosts: string[]; lenient: boolean; exhausted: boolean } => {
  if (!Array.isArray(data) || data.length === 0 || data.length > MAX_SIGN_DATA)
    return { hosts: [], lenient: false, exhausted: false };
  if (!data.every((b) => typeof b === 'number' && b >= 0 && b <= 255))
    return { hosts: [], lenient: false, exhausted: false };
  const { hosts, exhausted } = scanSignData(new Uint8Array(data as number[]), { authMessage: isAuthMessage(args) });
  return { hosts, lenient: decodeText(data) === null, exhausted };
};
const NOT_TEXT = 'inside data that is not plain text';
/** Protocol [2, 'auth message signature']: every @bsv/sdk Peer (BRC-103) signature. */
const isAuthMessage = (args: object) => {
  const p = (args as { protocolID?: unknown }).protocolID;
  return (
    Array.isArray(p) && p[0] === 2 && typeof p[1] === 'string' && p[1].trim().toLowerCase() === 'auth message signature'
  );
};
const TOO_MUCH = `${UNCHECKABLE_REFUSAL} (too much encoded data to read)`;

export const CROSS_SITE_REFUSAL = 'This message is for a different site than the one asking you to sign it';
export const BLIND_SIGN_REFUSAL = 'Sites cannot ask for a signature over a hash the wallet cannot read';

/**
 * Our own sites that sign BSM digests (AIP posts, boost sighashes, escrow arbiter digests) through hashToDirectlySign.
 * Exact hosts only (owner, 15 Nov 2026, "tightening"): no subdomain of one counts, so a stray or taken-over
 * subdomain can't blind-sign. bit-sign.online is no longer one: its posting pages redirect to bChatX.
 * bsocialx.com and scammerscartel.com (with www) are our own sites running the bChatX posting pages, added on the
 * owner's word on 15 Nov 2026. ⚠ Any further host needs the owner's word; crossSiteSignGuard.test.ts pins this list.
 */
export const BLIND_HASH_SITES: ReadonlySet<string> = new Set([
  'www.bchatx.com',
  'bchatx.com',
  'chat.bwalletx.com',
  'bsocialx.com',
  'www.bsocialx.com',
  'scammerscartel.com',
  'www.scammerscartel.com',
]);
/**
 * The caller is exactly one of them. `caller` is a bareHost (signDataScan.ts): lower-case, no scheme, port, path,
 * trailing dot or pairing suffix, so "exactly" has one spelling.
 */
export const blindHashAllowed = (caller: string) => BLIND_HASH_SITES.has(caller);

/**
 * The posting key ([1,'sigma'], the BAP key that AIP-signs feed posts) signs Bitcoin Signed Messages, and a BSM digest
 * is sha256(sha256(prefix ‖ message)). createSignature signs sha256(data), so `data` = the 32-byte inner hash gives
 * exactly a BSM signature over a message the wallet never saw: the same blind signature as hashToDirectlySign, by
 * the other door (review of the feed-author binding, 15 Nov 2026: a site holding the standing posting grant could
 * sign a feed-author claim that hands the user's posting address to another name). So exactly 32 bytes of `data`
 * under that protocol counts as a blind hash, under the same rule. Nothing legitimate sends it: @1sat/actions and
 * @1sat/templates sign posts, SIGMA seals and BAP messages through hashToDirectlySign only, and a real post is never
 * 32 bytes of digest.
 */
const BSM_INNER_HASH_LENGTH = 32;
const isPostingProtocol = (args: object) => {
  const p = (args as { protocolID?: unknown }).protocolID;
  return Array.isArray(p) && p[0] === 1 && typeof p[1] === 'string' && p[1].trim().toLowerCase() === 'sigma';
};
/** The call asks for a signature over a digest the wallet cannot read (see above). */
export const isBlindHashRequest = (args: object, method: string = 'createSignature'): boolean => {
  if ((args as { hashToDirectlySign?: unknown }).hashToDirectlySign !== undefined) return true;
  // Only a signature can be replayed as a BSM signature; an HMAC over 32 bytes is no such thing.
  if (method !== 'createSignature') return false;
  const data = (args as { data?: unknown }).data;
  return Array.isArray(data) && data.length === BSM_INNER_HASH_LENGTH && isPostingProtocol(args);
};

/**
 * A phone-paired originator ("<host>[.c<hex>].paired.invalid"). Its host is only what the relay read from an Origin
 * header, which any non-browser client can set; it names a site only when the site proved its origin at pairing.
 */
const PAIRED_RE = /\.paired\.invalid\.?(?::\d+)?(?:\/.*)?$/i;
export const isPairedOriginator = (originator: string) => PAIRED_RE.test(originator.trim());
/** Normalised paired key for comparing an originator with a stored session key (scheme, port, path dropped). */
export const pairedKeyHost = (originator: string) =>
  originator
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');

/** Which paired originators proved their origin (set by mobile/pair/sessions.ts). Default: none did. */
let provenPairing: (originator: string) => boolean = () => false;
export const setProvenPairingCheck = (fn: (originator: string) => boolean) => {
  provenPairing = fn;
};

/** Why this outside call must be refused, or null. Only data that names a site (read as text, or leniently) is checked. */
export const crossSiteSignRefusal = (
  originator: string | undefined,
  args: unknown,
  method: string = 'createSignature',
): string | null => {
  if (!originator || !args || typeof args !== 'object') return null;
  // b-Aware 25 Oct 2026 (yudhaekasaputra1, widiaaw382): the guard failed open on what it couldn't read. For an outside
  // caller it now fails closed: data that isn't a byte array, data over MAX_SIGN_DATA, and a caller whose host it
  // can't parse are refused. A missing `data` (e.g. a hash-only call, handled below) is not a "non-array".
  const data = (args as { data?: unknown }).data;
  if (data !== undefined) {
    if (!Array.isArray(data)) return `${UNCHECKABLE_REFUSAL} (data is not a byte array)`;
    if (data.length > MAX_SIGN_DATA) return `${UNCHECKABLE_REFUSAL} (message over ${MAX_SIGN_DATA / 1024} KB)`;
  }
  // b-Aware 25 Oct 2026 (0xzero): an unproven pairing's host is only claimed. Stripping the pairing suffix let a
  // forged-origin pairing get a login signature for the site it claimed. It now counts as no site at all: data naming
  // any site, and blind hashes, are refused; data naming no site signs as before.
  if (isPairedOriginator(originator) && !provenPairing(originator)) {
    if (isBlindHashRequest(args, method)) return BLIND_SIGN_REFUSAL;
    const { hosts: named, lenient, exhausted } = namedHosts(data, args as object);
    if (exhausted) return TOO_MUCH;
    return named.length
      ? `${CROSS_SITE_REFUSAL} (${named[0]}${lenient ? `, ${NOT_TEXT}` : ''}; this pairing did not prove its site)`
      : null;
  }
  const caller = bareHost(originator);
  if (!caller) {
    // A caller with no parsable host (a single-label name, an extension id) can't be any site a message names: refuse
    // a blind hash or data that names a site; data naming no site signs as before.
    if (isBlindHashRequest(args, method)) return BLIND_SIGN_REFUSAL;
    const { hosts: named, lenient, exhausted } = namedHosts(data, args as object);
    if (exhausted) return TOO_MUCH;
    return named.length ? `${CROSS_SITE_REFUSAL} (${named[0]}${lenient ? `, ${NOT_TEXT}` : ''})` : null;
  }
  // A bare hash can't be read, so it can't be checked: an outside caller must send the data itself. Our own
  // chat sites are the exception: bChatX AIP-signs every post over a BSM digest, which `data` can't stand in for
  // (owner, 25 Oct 2026: posting broke after the blind-sign refusal).
  // The same goes for a 32-byte `data` under the posting protocol: a BSM digest by another door (isBlindHashRequest).
  if (isBlindHashRequest(args, method) && !blindHashAllowed(caller)) return BLIND_SIGN_REFUSAL;
  // Text or not (b-Aware triage 13 Nov 2026), every site the data names must be the caller's: one matching field must
  // not launder another, and bytes that aren't valid text are read leniently rather than waved through.
  const { hosts, lenient, exhausted } = namedHosts(data, args as object);
  if (exhausted) return TOO_MUCH;
  const other = hosts.find((h) => !sameSite(h, caller));
  return other ? `${CROSS_SITE_REFUSAL} (${other}${lenient ? `, ${NOT_TEXT}` : ''})` : null;
};

const SIGNING_METHODS = ['createSignature', 'createHmac'] as const;

export const MALFORMED_SIGN_REFUSAL = 'The wallet could not read this signing request';
/**
 * Defence in depth (final check of the feed-author binding, 15 Nov 2026): a site's createSignature whose shape the
 * checks above can't read is refused here, not left for the SDK to throw on later. `data`, when present, must be a
 * plain dense array of integers 0-255 (a hole, a fraction or an object with a length could read as one thing here
 * and sign as another); `protocolID` must be a [number, string] pair. A typed array stays refused for a site, as
 * before. Well-formed requests are untouched.
 */
export const malformedSignRefusal = (args: unknown): string | null => {
  if (!args || typeof args !== 'object') return `${MALFORMED_SIGN_REFUSAL} (no arguments)`;
  const { data, protocolID: p } = args as { data?: unknown; protocolID?: unknown };
  if (!Array.isArray(p) || p.length !== 2 || !Number.isInteger(p[0]) || typeof p[1] !== 'string')
    return `${MALFORMED_SIGN_REFUSAL} (protocolID is not a [level, name] pair)`;
  if (data === undefined) return null;
  if (!Array.isArray(data) || Object.getPrototypeOf(data) !== Array.prototype)
    return `${UNCHECKABLE_REFUSAL} (data is not a byte array)`;
  for (let i = 0; i < data.length; i++) {
    const b: unknown = i in data ? data[i] : undefined;
    if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 255)
      return `${UNCHECKABLE_REFUSAL} (data is not a byte array)`;
  }
  return null;
};

/**
 * An originator that names a site the wallet can hold to an action: it has a host, and a phone pairing proved it.
 * The same two tests crossSiteSignRefusal makes before it lets any site sign.
 */
const namesProvenSite = (originator: string) =>
  !(isPairedOriginator(originator) && !provenPairing(originator)) && bareHost(originator) !== null;

type ActionCall = (args: unknown, originator?: string) => Promise<unknown>;

/**
 * Wrap the manager's signing methods so an outside originator's cross-site message is refused before any prompt.
 * One bare hash is let through: the sighash of an input the same site must unlock in its own pending action, asked
 * with that input's key (pendingSighash.ts). The guard watches createAction / signAction / abortAction for that only;
 * it changes nothing about them.
 */
export function guardCrossSiteSigning<T extends object>(manager: T, adminOriginator: string, now?: () => number): T {
  const m = manager as Record<string, unknown>;
  const pending = new PendingSighashes(now);
  // The key a createSignature would use, derived as the wallet itself: compared, never returned to the site.
  const getPublicKey = m.getPublicKey;
  const signingKey = async (key: { protocolID: unknown; keyID: unknown; counterparty: unknown }) => {
    if (typeof getPublicKey !== 'function') return undefined;
    const r = (await (getPublicKey as ActionCall).call(manager, { ...key, forSelf: true }, adminOriginator)) as
      | { publicKey?: string }
      | undefined;
    return r?.publicKey;
  };
  const createAction = m.createAction;
  if (typeof createAction === 'function')
    m.createAction = async (args: unknown, originator?: string) => {
      const result = (await (createAction as ActionCall).call(manager, args, originator)) as
        | { signableTransaction?: { tx?: unknown; reference?: unknown } }
        | undefined;
      // Only once the manager has returned it: its output check and its pay sheet have passed by then.
      if (originator && originator !== adminOriginator && result?.signableTransaction)
        pending.record(originator, args, result.signableTransaction);
      return result;
    };
  // Signed, aborted, or a sign that failed (the manager aborts the action then): its sighashes are over. Another
  // site naming the reference is refused by the manager and ends nothing here.
  for (const method of ['signAction', 'abortAction'] as const) {
    const original = m[method];
    if (typeof original !== 'function') continue;
    m[method] = async (args: unknown, originator?: string) => {
      const reference = (args as { reference?: unknown } | null)?.reference;
      const own = originator === adminOriginator || pending.owner(reference) === originator;
      try {
        const result = await (original as ActionCall).call(manager, args, originator);
        pending.settle(reference);
        return result;
      } catch (e) {
        if (own) pending.settle(reference);
        throw e;
      }
    };
  }
  for (const method of SIGNING_METHODS) {
    const original = m[method];
    if (typeof original !== 'function') continue;
    m[method] = async (args: unknown, originator?: string) => {
      if (originator && originator !== adminOriginator) {
        // No site signs in as the user to the wallet's own servers (ownBackendKeys.ts: seeded first-party keys and the
        // configured stores' keys; refused while a configured one hasn't connected yet).
        const own = ownBackendRefusal(args);
        if (own) throw new Error(own);
      }
      if (originator !== adminOriginator) {
        const malformed = method === 'createSignature' ? malformedSignRefusal(args) : null;
        if (malformed) throw new Error(malformed);
        const refusal = crossSiteSignRefusal(originator, args, method);
        // The one readable hash (pendingSighash.ts). Every other refusal, and every other hash, stands.
        const ownSighash =
          refusal === BLIND_SIGN_REFUSAL && method === 'createSignature' && !!originator && namesProvenSite(originator)
            ? await pending.request(originator, args, signingKey)
            : null;
        if (refusal && !ownSighash) throw new Error(refusal);
        // Signed from the copy that was checked, not from an object the caller still holds.
        if (ownSighash) args = ownSighash;
      }
      return (original as (a: unknown, o?: string) => Promise<unknown>).call(manager, args, originator);
    };
  }
  return manager;
}
