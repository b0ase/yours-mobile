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
 */

// Keys that say which site a message is for. uri/url/site/callback/redirect shapes added after the b-Aware
// report of 24 Oct 2026 (b_feedback 51): a sign-in message naming its site through one of these was not checked.
const BINDING_KEYS = [
  'domain',
  'origin',
  'host',
  'hostname',
  'audience',
  'aud',
  'uri',
  'url',
  'site',
  'website',
  'realm',
  'rp',
  'rp_id',
  'rpid',
  'relying_party',
  'callback',
  'callback_url',
  'callback_uri',
  'redirect',
  'redirect_uri',
  'redirect_url',
  'return_to',
  'return_url',
  'return_uri',
];
const BINDING_SET = new Set(BINDING_KEYS);
// b-Aware 29 Oct 2026 (squ11z1): the key list was matched with \b on the raw key, so camelCase and kebab-case keys
// (redirectUrl, callbackUrl, returnTo, rpId, relyingParty, redirect-uri) were never seen. Every key is now read and
// normalised to snake_case first; a key in the list, or ending in a site-ish word (login_url, app_origin,
// expected_domain, post_login_redirect), binds.
const ANY_FIELD = /["']?([A-Za-z_][\w-]*)["']?\s*[:=]\s*["']?([^\s"',;}\]]+)/g;
const BINDING_SUFFIX =
  /(?:^|_)(?:url|uri|origin|domain|host|hostname|audience|redirect|callback|return_to|realm|rp_id|relying_party)$/;
/** camelCase / PascalCase / kebab-case / snake_case key to one snake_case form. */
export const normaliseKey = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
const isBindingKey = (key: string) => {
  const k = normaliseKey(key);
  return BINDING_SET.has(k) || BINDING_SUFFIX.test(k);
};
// "<host> wants you to sign in" (SIWE), "<host> wallet login:" and "Sign in to <host>" lines, anywhere in the
// text: a prefix such as "Login: " or a JSON string around the line must not hide it.
// Also IPv4 literals and "localhost" (b-Aware 25 Oct 2026, Widia): a challenge for 10.0.0.5 named no site before.
const HOST = '((?:(?:[a-z0-9-]+\\.)+[a-z]{2,}|(?:\\d{1,3}\\.){3}\\d{1,3}|localhost)(?::\\d+)?)';
// b-Aware 28 Oct 2026 (Jacob Anderson, 0qu5xz): "Sign into", "Log onto", "good.com - sign in", "Welcome to good.com"
// and similar wordings named no site, so another site got the login signature. Punctuation may sit between the host
// and the phrase, and the common login verbs before a host now bind too.
const SEP = '[\\s,:\u2013\u2014-]*';
const SIGN_IN_LINES = [
  new RegExp(
    `(?:^|[\\s"'\`(:])${HOST}\\b${SEP}(?:wants you to sign in|(?:wallet |account )?(?:log ?in|sign[ -]?in)\\b|(?:requests|requires) (?:authentication|verification|a signature)\\b|wants to (?:connect|sign you in|sign in|log you in|log in|authenticate|verify)\\b)`,
    'gim',
  ),
  new RegExp(`\\b(?:sign|log) ?(?:in ?to|on ?to)\\s+${HOST}`, 'gi'),
  new RegExp(
    `\\b(?:welcome to|authenticate(?: (?:to|with|for|on|at))?|verify (?:your )?(?:identity|wallet) (?:for|with|on)|authori[sz]e(?: (?:to|for|with|on))?|connect (?:to|with)|(?:sign|log)[ -]?(?:in|on|up) (?:with|via|at|on|for|through|using)|log[ -]?in (?:to|with|via|at|on|for)|continue (?:with|to))\\s+${HOST}`,
    'gi',
  ),
];
const HOST_RE = /^(?:[a-z0-9-]+(\.[a-z0-9-]+)+|localhost)$/;

/** Lower-case hostname with no port, no trailing dot and no pairing suffix (".c<hex>.paired.invalid"). */
export const bareHost = (value: string): string | null => {
  let v = value.trim().toLowerCase();
  if (!v) return null;
  if (v.includes('://')) {
    try {
      v = new URL(v).hostname;
    } catch {
      return null;
    }
  }
  v = v
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '')
    .replace(/(\.c[0-9a-f]{44})?\.paired\.invalid$/, '');
  return HOST_RE.test(v) ? v : null;
};

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

/** Every site the text says it is meant for. */
export const boundHosts = (text: string): string[] => {
  const out = new Set<string>();
  for (const re of SIGN_IN_LINES) {
    for (const m of text.matchAll(re)) {
      const h = bareHost(m[1]);
      if (h) out.add(h);
    }
  }
  for (const m of text.matchAll(ANY_FIELD)) {
    if (!isBindingKey(m[1])) continue;
    const h = bareHost(m[2]);
    if (h) out.add(h);
  }
  return [...out];
};

export const CROSS_SITE_REFUSAL = 'This message is for a different site than the one asking you to sign it';
export const BLIND_SIGN_REFUSAL = 'Sites cannot ask for a signature over a hash the wallet cannot read';

/** Our own sites that sign BSM digests (AIP posts, boost sighashes, escrow arbiter digests) through hashToDirectlySign. */
const BLIND_HASH_SITES = ['bchatx.com', 'chat.bwalletx.com', 'bit-sign.online'];
/** The caller is one of them or a subdomain of one (never a parent: bwalletx.com is not chat.bwalletx.com). */
export const blindHashAllowed = (caller: string) =>
  BLIND_HASH_SITES.some((site) => caller === site || caller.endsWith(`.${site}`));

const printable = (text: string) => {
  if (!text) return false;
  let n = 0;
  for (const ch of text) if (ch >= ' ' || ch === '\n' || ch === '\r' || ch === '\t') n++;
  return n / text.length >= 0.9;
};
const utf8 = (bytes: Uint8Array): string | null => {
  try {
    const t = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return printable(t) ? t : null;
  } catch {
    return null;
  }
};
const B64_RE = /^[A-Za-z0-9+/_-]{16,}={0,2}$/;
const HEX_RE = /^(?:[0-9a-fA-F]{2}){8,}$/;

/**
 * The same text in the other spellings a challenge can hide a site name in (b-Aware 24-25 Oct 2026): JSON escapes
 * (\u0064omain, evil\u002ecom), percent-encoding, and a whole message or a token inside it sent as base64 or hex.
 * Bounded: a few layers, a few hundred candidates.
 */
export const textVariants = (text: string): string[] => {
  const out = new Set<string>();
  const todo: [string, number][] = [[text, 0]];
  while (todo.length && out.size < 256) {
    const [t, depth] = todo.shift()!;
    if (out.has(t)) continue;
    out.add(t);
    if (depth >= 3) continue;
    const add = (v: string | null) => v && v !== t && todo.push([v, depth + 1]);
    add(
      t.replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/\\\//g, '/'),
    );
    try {
      add(decodeURIComponent(t.replace(/\+/g, ' ')));
    } catch {
      /* not percent-encoded */
    }
    for (const tok of new Set([t.trim(), ...(t.match(/[A-Za-z0-9+/_=-]{16,}/g) ?? [])])) {
      if (HEX_RE.test(tok)) add(utf8(Uint8Array.from(tok.match(/../g)!.map((h) => parseInt(h, 16)))));
      else if (B64_RE.test(tok)) {
        try {
          const b = atob(
            tok
              .replace(/-/g, '+')
              .replace(/_/g, '/')
              .padEnd(Math.ceil(tok.length / 4) * 4, '='),
          );
          add(utf8(Uint8Array.from(b, (c) => c.charCodeAt(0))));
        } catch {
          /* not base64 */
        }
      }
    }
  }
  return [...out];
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

/** Why this outside call must be refused, or null. Only text data that names a site is checked. */
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
    const t = decodeText((args as { data?: unknown }).data);
    const named = t === null ? [] : [...new Set(textVariants(t).flatMap(boundHosts))];
    return named.length ? `${CROSS_SITE_REFUSAL} (${named[0]}; this pairing did not prove its site)` : null;
  }
  const caller = bareHost(originator);
  if (!caller) {
    // A caller with no parsable host (a single-label name, an extension id) can't be any site a message names: refuse
    // a blind hash or data that names a site; data naming no site signs as before.
    if ((args as { hashToDirectlySign?: unknown }).hashToDirectlySign !== undefined) return BLIND_SIGN_REFUSAL;
    const t = decodeText(data);
    const named = t === null ? [] : [...new Set(textVariants(t).flatMap(boundHosts))];
    return named.length ? `${CROSS_SITE_REFUSAL} (${named[0]})` : null;
  }
  // A bare hash can't be read, so it can't be checked: an outside caller must send the data itself. Our own
  // chat sites are the exception: bChatX AIP-signs every post over a BSM digest, which `data` can't stand in for
  // (owner, 25 Oct 2026: posting broke after the blind-sign refusal).
  if ((args as { hashToDirectlySign?: unknown }).hashToDirectlySign !== undefined && !blindHashAllowed(caller))
    return BLIND_SIGN_REFUSAL;
  const text = decodeText((args as { data?: unknown }).data);
  if (text === null) return null;
  const hosts = [...new Set(textVariants(text).flatMap(boundHosts))];
  if (hosts.length === 0) return null;
  // Every site the message names must be the caller's: one matching field must not launder another.
  const other = hosts.find((h) => !sameSite(h, caller));
  return other ? `${CROSS_SITE_REFUSAL} (${other})` : null;
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
