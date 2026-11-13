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
 * Not covered here: relaying a BRC-103 session itself. evil.com can open a BRC-103 (AuthFetch) session with good.com's
 * server and ask the wallet to sign its messages; those frames name no site, and a signature under 'auth message
 * signature' verifies at any BRC-103 peer. Stopping that needs the peer's identity (the counterparty) tied to the
 * calling site, not a reading of the data.
 */

import { bareHost, scanSignData } from './signDataScan';

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

/** Our own sites that sign BSM digests (AIP posts, boost sighashes, escrow arbiter digests) through hashToDirectlySign. */
const BLIND_HASH_SITES = ['bchatx.com', 'chat.bwalletx.com', 'bit-sign.online'];
/** The caller is one of them or a subdomain of one (never a parent: bwalletx.com is not chat.bwalletx.com). */
export const blindHashAllowed = (caller: string) =>
  BLIND_HASH_SITES.some((site) => caller === site || caller.endsWith(`.${site}`));

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
export const crossSiteSignRefusal = (originator: string | undefined, args: unknown): string | null => {
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
    if ((args as { hashToDirectlySign?: unknown }).hashToDirectlySign !== undefined) return BLIND_SIGN_REFUSAL;
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
    if ((args as { hashToDirectlySign?: unknown }).hashToDirectlySign !== undefined) return BLIND_SIGN_REFUSAL;
    const { hosts: named, lenient, exhausted } = namedHosts(data, args as object);
    if (exhausted) return TOO_MUCH;
    return named.length ? `${CROSS_SITE_REFUSAL} (${named[0]}${lenient ? `, ${NOT_TEXT}` : ''})` : null;
  }
  // A bare hash can't be read, so it can't be checked: an outside caller must send the data itself. Our own
  // chat sites are the exception: bChatX AIP-signs every post over a BSM digest, which `data` can't stand in for
  // (owner, 25 Oct 2026: posting broke after the blind-sign refusal).
  if ((args as { hashToDirectlySign?: unknown }).hashToDirectlySign !== undefined && !blindHashAllowed(caller))
    return BLIND_SIGN_REFUSAL;
  // Text or not (b-Aware triage 13 Nov 2026), every site the data names must be the caller's: one matching field must
  // not launder another, and bytes that aren't valid text are read leniently rather than waved through.
  const { hosts, lenient, exhausted } = namedHosts(data, args as object);
  if (exhausted) return TOO_MUCH;
  const other = hosts.find((h) => !sameSite(h, caller));
  return other ? `${CROSS_SITE_REFUSAL} (${other}${lenient ? `, ${NOT_TEXT}` : ''})` : null;
};

const SIGNING_METHODS = ['createSignature', 'createHmac'] as const;

/** Wrap the manager's signing methods so an outside originator's cross-site message is refused before any prompt. */
export function guardCrossSiteSigning<T extends object>(manager: T, adminOriginator: string): T {
  const m = manager as Record<string, unknown>;
  for (const method of SIGNING_METHODS) {
    const original = m[method];
    if (typeof original !== 'function') continue;
    m[method] = async (args: unknown, originator?: string) => {
      if (originator !== adminOriginator) {
        const refusal = crossSiteSignRefusal(originator, args);
        if (refusal) throw new Error(refusal);
      }
      return (original as (a: unknown, o?: string) => Promise<unknown>).call(manager, args, originator);
    };
  }
  return manager;
}
