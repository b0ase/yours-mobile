/**
 * Which sites a piece of data to be signed names (used by crossSiteSignGuard.ts).
 *
 * b-Aware triage and reviews, 13 Nov 2026. The guard reads whatever an outside site asks it to sign, before any
 * prompt, so this must be cheap on every input and must read the data the way a lenient verifier at the named site
 * could:
 * - Linear work only. No regex here has overlapping quantifiers on attacker-sized runs; fields are found by a
 *   tokeniser, not a backtracking regex; and the whole scan has a character budget (MAX_SCAN_CHARS). Past it the scan
 *   stops and says so, and the guard refuses rather than signs.
 * - Every byte string is read twice: with junk (invalid UTF-8, control bytes) as spaces, and with control bytes
 *   dropped, which also reads ASCII sent as UTF-16 or split by NULs ("go\x01od.com"). Plain text reads once.
 * - Each reading is also read after lenient decode passes (JSON \u and \x escapes, valid %XX runs, HTML entities,
 *   zero-width characters dropped), up to DECODE_PASSES for layered encoding, and base64 / hex tokens are decoded and
 *   read the same way, two levels deep. Gzip and zlib data is inflated, bounded.
 * - A URL value is read the way a WHATWG parser reads it: its host is whatever follows the LAST '@' before the first
 *   / \ ? # or line break, so userinfo ("https://evil.com&@good.com") can't hide it.
 * - Fields: key: value, key=value, "key" => value (Ruby), <key>value</key> (XML).
 * - Bytes that aren't text (random blobs, encrypted envelopes) only count a host with a real top-level label (2+
 *   letters or xn--), and Unicode in them is not converted to punycode, so junk doesn't read as a site name.
 * Not read: raw deflate (no header to recognise), other compression. AuthFetch frames: see scanSignData.
 */

import { Gunzip, Unzlib } from 'fflate';

// Keys that say which site a message is for. uri/url/site/callback/redirect shapes added after the b-Aware
// report of 24 Oct 2026 (b_feedback 51): a sign-in message naming its site through one of these was not checked.
const BINDING_SET = new Set([
  'domain',
  'host',
  'hostname',
  'audience',
  'aud',
  'site',
  'website',
  'realm',
  'rp',
  'rp_id',
  'rpid',
  'relying_party',
  'origin',
  'uri',
  'url',
  'callback',
  'callback_url',
  'callback_uri',
  'redirect',
  'redirect_uri',
  'redirect_url',
  'return_to',
  'return_url',
  'return_uri',
]);
// b-Aware 29 Oct 2026 (squ11z1): camelCase and kebab-case keys (redirectUrl, callbackUrl, returnTo, rpId,
// relyingParty, redirect-uri) were never seen. Every key is normalised to snake_case first; a key in the list, or
// ending in a site-ish word (login_url, app_origin, expected_domain, post_login_redirect), binds.
const BINDING_SUFFIX =
  /(?:^|_)(?:url|uri|origin|domain|host|hostname|audience|redirect|callback|return_to|realm|rp_id|relying_party)$/;

/** camelCase / PascalCase / kebab-case / snake_case key to one snake_case form. */
export const normaliseKey = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();

const MAX_KEY = 64;
const isBindingKey = (key: string) => {
  if (key.length > MAX_KEY) return false;
  // Also the plain lower-case key: "DoMaIn" normalises to do_ma_in.
  for (const k of new Set([normaliseKey(key), key.toLowerCase().replace(/-/g, '_')]))
    if (BINDING_SET.has(k) || BINDING_SUFFIX.test(k)) return true;
  return false;
};

// "<host> wants you to sign in" (SIWE), "<host> wallet login:" and "Sign in to <host>" lines, anywhere in the
// text: a prefix such as "Login: " or a JSON string around the line must not hide it.
// Also IPv4 literals and "localhost" (b-Aware 25 Oct 2026, Widia): a challenge for 10.0.0.5 named no site before.
// Labels are separated by a dot that the label class excludes, so a run of labels backtracks in linear time.
// Unicode labels too (IDN, N5): "Sign in to bücher.de" names xn--bcher-kva.de.
const HOST = '((?:(?:[\\p{L}\\p{N}-]+\\.)+\\p{L}{2,}|(?:\\d{1,3}\\.){3}\\d{1,3}|localhost)(?::\\d+)?)';
// b-Aware 28 Oct 2026 (Jacob Anderson, 0qu5xz): "Sign into", "Log onto", "good.com - sign in", "Welcome to good.com"
// and similar wordings named no site, so another site got the login signature.
const SEP = '[\\s,:–—-]*';
const SIGN_IN_LINES = [
  new RegExp(
    `(?:^|[\\s"'\`(:])${HOST}\\b${SEP}(?:wants you to sign in|(?:wallet |account )?(?:log ?in|sign[ -]?in)\\b|(?:requests|requires) (?:authentication|verification|a signature)\\b|wants to (?:connect|sign you in|sign in|log you in|log in|authenticate|verify)\\b)`,
    'gimu',
  ),
  new RegExp(`\\b(?:sign|log) ?(?:in ?to|on ?to)\\s+${HOST}`, 'giu'),
  new RegExp(
    `\\b(?:welcome to|authenticate(?: (?:to|with|for|on|at))?|verify (?:your )?(?:identity|wallet) (?:for|with|on)|authori[sz]e(?: (?:to|for|with|on))?|connect (?:to|with)|(?:sign|log)[ -]?(?:in|on|up) (?:with|via|at|on|for|through|using)|log[ -]?in (?:to|with|via|at|on|for)|continue (?:with|to))\\s+${HOST}`,
    'giu',
  ),
];
const HOST_RE = /^(?:[a-z0-9-]+(\.[a-z0-9-]+)+|localhost)$/;
// WHATWG "special" schemes: after "https:" any run of / or \ (even none) starts the host.
const SPECIAL = new Set(['http', 'https', 'ws', 'wss', 'ftp', 'file']);
const MAX_VALUE = 1024;

/**
 * Lower-case hostname with no port, no trailing dot and no pairing suffix (".c<hex>.paired.invalid"). Read the way a
 * WHATWG URL parser would (review 13 Nov 2026, A4): tabs and newlines dropped, backslashes as slashes, "https:good.com",
 * "https:/good.com" and "//good.com" all name good.com; a Unicode or percent-encoded host is converted (punycode).
 */
export const bareHost = (value: string, lenient = false): string | null => {
  let v = value
    .slice(0, MAX_VALUE)
    .replace(/[\t\n\r]/g, '')
    .trim()
    .replace(/\\/g, '/');
  if (!v) return null;
  let authority = false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(v);
  if (scheme && (SPECIAL.has(scheme[1].toLowerCase()) || v.startsWith('//', scheme[0].length))) {
    v = v.slice(scheme[0].length).replace(/^\/+/, '');
    authority = true;
  } else if (v.startsWith('//')) {
    v = v.slice(2);
    authority = true;
  }
  v = v.replace(/[/?#].*$/, '');
  if (authority) v = v.slice(v.lastIndexOf('@') + 1);
  v = v.replace(/:\d*$/, '').toLowerCase();
  // Anything with an ASCII character no host can hold is not one (checked before the costlier URL conversion).
  if (/[^a-z0-9.%\-\u0080-\uffff]/.test(v)) return null;
  // Percent-encoding decoded once, as a URL parser does for a host; what still holds a % or a non-host character is
  // not a host (so a run of %25 doesn't reach the URL constructor, whose throw is the slow path).
  if (v.includes('%')) {
    try {
      v = decodeURIComponent(v).toLowerCase();
    } catch {
      return null;
    }
    if (/[^a-z0-9.\-\u0080-\uffff]/.test(v)) return null;
  }
  // Unicode and numeric-IPv4 hosts ("0x7f.1") converted as a URL parser does.
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(v) || NUMERIC_HOST.test(v)) {
    try {
      v = new URL(`http://${v}`).hostname;
    } catch {
      return null;
    }
    // In bytes that aren't text, Unicode that converts to punycode is junk, not an IDN (review N4); fullwidth letters
    // and the ideographic full stop convert to plain ASCII and still count (follow-up F2).
    if (lenient && /(?:^|\.)xn--/.test(v)) return null;
  }
  v = v.replace(/\.$/, '').replace(/(\.c[0-9a-f]{44})?\.paired\.invalid$/, '');
  if (!HOST_RE.test(v)) return null;
  // In bytes that aren't text, a name needs a real top-level label ("iek.md1" and "z.m" out of a random blob don't).
  if (lenient && !LENIENT_TLD.test(v)) return null;
  return v;
};
// Two to four numeric labels, at least one in hex (0x7f.1), or three or more (127.0.1): a parser reads an IPv4 address.
// One bare number ("6") is left alone, so junk in a random blob doesn't become 0.0.0.6.
const NUMERIC_HOST = /^(?=[^.]*\.)(?=.*0x|(?:[^.]*\.){2})(?:0x[0-9a-f]*|\d+)(?:\.(?:0x[0-9a-f]*|\d+)){1,3}\.?$/i;
const LENIENT_TLD = /(?:\.(?:[a-z]{2,}|xn--[a-z0-9-]+)|^localhost|^(?:\d{1,3}\.){3}\d{1,3})$/;

/**
 * The host of a URL value read the way a WHATWG parser reads it (review 13 Nov 2026, N1): after "scheme://", a special
 * "scheme:" or "//", the authority runs to the first / \ ? # or line break, and the host is whatever follows its LAST
 * '@'. Everything else in the authority (& | < , ; space quotes...) is userinfo. Null when `s` doesn't start one.
 */
const isAuthorityEnd = (c: number) => c === 47 || c === 92 || c === 63 || c === 35 || c === 10 || c === 13; // / \ ? # LF CR
// Unquoted values (follow-ups F1 and B1): white space (a text line), or a raw & or ; (form syntax, key=value), ends the
// authority only when what follows starts a new field before the next '@' ("&email=bob@x.com", " Paymail: bob@x.com").
// Otherwise the parser reads through it as userinfo: "https://evil.com&@good.com" and "https://evil.com @good.com"
// name good.com. Tabs are dropped by the parser, so they never end it.
const isSoftLineEnd = (c: number) => c === 32 || c === 11 || c === 12 || c === 0xa0 || c === 0x85;
const isSoftFormEnd = (c: number) => isSoftLineEnd(c) || c === 38 || c === 59;
/** Per string and rule, built once, so every lookup is constant time. */
type AuthorityIndex = {
  hard: Int32Array; // next / \ ? # LF CR
  soft: Int32Array; // next soft end
  nextAt: Int32Array; // next '@'
  lastAt: Int32Array; // last '@' before
  nextField: Int32Array; // next start of a field: a key after a soft end, followed by '=' or ': '
};
const authorityIndex = (s: string, isSoft: (c: number) => boolean): AuthorityIndex => {
  const n = s.length;
  const hard = new Int32Array(n + 1);
  const soft = new Int32Array(n + 1);
  const nextAt = new Int32Array(n + 1);
  const nextField = new Int32Array(n + 1);
  hard[n] = soft[n] = nextAt[n] = nextField[n] = n;
  const c = (i: number) => s.charCodeAt(i);
  const keyChar = (k: number) =>
    (k >= 65 && k <= 90) || (k >= 97 && k <= 122) || (k >= 48 && k <= 57) || k === 95 || k === 45;
  // A field starts at a key run that begins right after a soft end and is followed by '=' or ': '.
  const fieldAt = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!keyChar(c(i)) || (i > 0 && !isSoft(c(i - 1)))) continue;
    let j = i;
    while (j < n && keyChar(c(j))) j++;
    let k = j;
    while (k < n && c(k) === 32) k++;
    if (k < n && (c(k) === 61 || (c(k) === 58 && k + 1 < n && isSpace(c(k + 1))))) fieldAt[i] = 1;
    i = j - 1;
  }
  for (let i = n - 1; i >= 0; i--) {
    hard[i] = isAuthorityEnd(c(i)) ? i : hard[i + 1];
    soft[i] = isSoft(c(i)) ? i : soft[i + 1];
    nextAt[i] = c(i) === 64 ? i : nextAt[i + 1];
    nextField[i] = fieldAt[i] ? i : nextField[i + 1];
  }
  const lastAt = new Int32Array(n + 1);
  let la = -1;
  for (let i = 0; i <= n; i++) {
    lastAt[i] = la;
    if (i < n && c(i) === 64) la = i;
  }
  return { hard, soft, nextAt, lastAt, nextField };
};
const authorityHost = (s: string, from: number, lenient: boolean, idx?: AuthorityIndex): string | null => {
  let head = s.slice(from, from + 48);
  // A blob: URL's origin is the URL inside it.
  const blob = /^[ \t]*blob:/i.exec(head);
  if (blob) {
    from += blob[0].length;
    head = s.slice(from, from + 48);
  }
  const scheme = /^[ \t]*([a-z][a-z0-9+.-]*):/i.exec(head);
  let at: number;
  if (scheme && SPECIAL.has(scheme[1].toLowerCase())) at = from + scheme[0].length;
  else if (scheme && /^[/\\]{2}/.test(head.slice(scheme[0].length))) at = from + scheme[0].length;
  else if (/^[ \t]*[/\\]{2}/.test(head)) at = from;
  else return null;
  const c0 = (k: number) => s.charCodeAt(k);
  while (at < s.length && (c0(at) === 47 || c0(at) === 92 || c0(at) === 32 || c0(at) === 9)) at++;
  // No length cap (a long userinfo must not push the host out of reach): the index answers in constant time, and a
  // quoted value is read once.
  let end: number;
  let lastAt: number;
  if (idx) {
    end = idx.hard[at];
    // Read through soft ends while what follows each is userinfo (an '@' comes before any new field).
    // At most 64 steps per value (keeps crafted chains linear); past that the whole run is read as userinfo.
    for (let soft = idx.soft[at], steps = 0; soft < end && steps < 64; soft = idx.soft[soft + 1], steps++) {
      const nextAt = idx.nextAt[soft];
      if (nextAt >= end || idx.nextField[soft] < nextAt) {
        end = soft;
        break;
      }
      // Jump to the '@': the soft ends before it are userinfo too.
      soft = nextAt;
    }
    lastAt = idx.lastAt[end];
  } else {
    end = at;
    lastAt = -1;
    while (end < s.length && !isAuthorityEnd(c0(end))) {
      if (c0(end) === 64) lastAt = end;
      end++;
    }
  }
  // The host: host characters (tabs are dropped by the parser) and a port, after the last '@'.
  let h = lastAt >= at ? lastAt + 1 : at;
  let host = '';
  for (; h < end && host.length < 270; h++) {
    const ch = s[h];
    if (ch === '\t') continue;
    if (!/[A-Za-z0-9.%:[\]-]/.test(ch) && ch.charCodeAt(0) < 0x80) break;
    host += ch;
  }
  return host ? bareHost(`//${host}`, lenient) : null;
};

const isKeyStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95; // A-Z a-z _
const isKeyChar = (c: number) => isKeyStart(c) || (c >= 48 && c <= 57) || c === 45; // + 0-9 -
const isSpace = (c: number) => c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x85;
const isQuote = (c: number) => c === 34 || c === 39 || c === 96;
// A value ends at white space, quotes, separators, or the start of a query / next form field (so "a=1&domain=x" reads
// both fields: the old regex took "1&domain=x" as one value).
const STOPS = new Set([...'"\'`,;}]&?#<>|'].map((c) => c.charCodeAt(0)));
const isStop = (c: number) => isSpace(c) || STOPS.has(c);

/** The content of a quoted value starting at `from` (just after the quote), JSON escapes kept. */
const quoted = (s: string, from: number, q: number): string => {
  let j = from;
  while (j < s.length && s.charCodeAt(j) !== q) j += s.charCodeAt(j) === 92 ? 2 : 1;
  return s.slice(from, Math.min(j, s.length));
};
const JSON_UNESCAPE = /\\(?:u([0-9a-fA-F]{4})|(.))/g;
const jsonUnescape = (v: string) =>
  v.replace(JSON_UNESCAPE, (_, u: string | undefined, c: string | undefined) =>
    u ? String.fromCharCode(parseInt(u, 16)) : c === 't' ? '\t' : c === 'n' ? '\n' : c === 'r' ? '\r' : (c ?? ''),
  );

/**
 * key[:=]value pairs (also "key" => value and <key>value), found in one left-to-right pass: each character starts at
 * most one key, and values are read a bounded length. Same shape as the old `["']?(key)["']?\s*[:=]\s*["']?(value)`
 * regex, which backtracked quadratically on long words.
 */
/** Returns how many binding fields it read (each costs the scan budget extra: BINDING_COST). */
const fieldHosts = (s: string, lenient: boolean, out: Set<string>): number => {
  const n = s.length;
  let bindings = 0;
  let lineIdx: AuthorityIndex | undefined;
  let formIdx: AuthorityIndex | undefined;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (!isKeyChar(c)) {
      i++;
      continue;
    }
    // A run of key characters; the key starts at its first letter or underscore (as the regex would).
    const runStart = i;
    while (i < n && isKeyChar(s.charCodeAt(i))) i++;
    let k = runStart;
    while (k < i && !isKeyStart(s.charCodeAt(k))) k++;
    if (k === i) continue;
    let j = i;
    const xml = runStart > 0 && s.charCodeAt(runStart - 1) === 60 && j < n && s.charCodeAt(j) === 62; // <key>
    let form = false; // key=value (form syntax), not key: value or <key>
    if (xml) j++;
    else {
      if (j < n && isQuote(s.charCodeAt(j))) j++;
      while (j < n && isSpace(s.charCodeAt(j))) j++;
      if (j >= n || (s.charCodeAt(j) !== 58 && s.charCodeAt(j) !== 61)) continue; // ':' or '='
      form = s.charCodeAt(j) === 61 && s.charCodeAt(j + 1) !== 62;
      j++;
      if (j < n && s.charCodeAt(j) === 62) j++; // "=>"
      while (j < n && isSpace(s.charCodeAt(j))) j++;
    }
    const q = j < n && isQuote(s.charCodeAt(j)) ? s.charCodeAt(j) : 0;
    if (q) j++;
    const v = j;
    if (!isBindingKey(s.slice(k, i))) {
      // Not a binding: carry on from the value, which may hold fields of its own.
      i = v;
      continue;
    }
    bindings++;
    while (j < n && !isStop(s.charCodeAt(j))) j++;
    // A quoted URL is one string (JSON, a quoted attribute): its host is what a URL parser reads, nothing else, so
    // "https://evil.com&@good.com" names only good.com. Unquoted, the value may also have been split at & or ; by a
    // form parser, so both readings count (review N1).
    const asUrl = q
      ? authorityHost(jsonUnescape(quoted(s, v, q)), 0, lenient)
      : form
        ? authorityHost(s, v, lenient, (formIdx ??= authorityIndex(s, isSoftFormEnd)))
        : authorityHost(s, v, lenient, (lineIdx ??= authorityIndex(s, isSoftLineEnd)));
    if (q && asUrl) {
      out.add(asUrl);
      i = Math.max(j, i);
      continue;
    }
    const value = s.slice(v, Math.min(j, v + MAX_VALUE));
    const found: (string | null)[] = [bareHost(value, lenient), asUrl];
    // A form value split at the raw & or ; and then percent-decoded is read in full as a URL (F1): so
    // "redirect_uri=https%3A%2F%2Fevil.com%26%40good.com" names good.com, and a real "&email=" is another field.
    if (form && value.includes('%')) found.push(authorityHost(decodeOnce(value), 0, lenient));
    // A URL parser drops tabs and newlines, so "https://go<TAB>od.com" names good.com (review A4). Only when the
    // part before the break names no host: in "Origin: https://a.com<LF>Nonce: 1" the line break ends the value.
    if (!found[0] && /^(?:[a-z][a-z0-9+.-]*:)?[/\\]{2}[^/\\?#]*$/i.test(value)) {
      let e = j;
      while (e < n && (s.charCodeAt(e) === 9 || s.charCodeAt(e) === 10 || s.charCodeAt(e) === 13)) e++;
      if (e > j) {
        let f = e;
        while (f < n && !isStop(s.charCodeAt(f))) f++;
        if (f > e) found.push(bareHost(value + s.slice(e, Math.min(f, e + MAX_VALUE)), lenient));
      }
    }
    for (const h of found) if (h) out.add(h);
    // Carry on after the value as first read (a global regex would), so a long value is read once.
    i = Math.max(j, i);
  }
  return bindings;
};

// Every login line contains one of these words; most data contains none, so the line regexes are skipped.
const LINE_WORDS = /sign|log|wants|requ|welcome|authent|verify|authori|connect|continue/i;
const lineHosts = (s: string, lenient: boolean, out: Set<string>) => {
  if (!LINE_WORDS.test(s)) return;
  for (const re of SIGN_IN_LINES) {
    for (const m of s.matchAll(re)) {
      const h = bareHost(m[1], lenient);
      if (h) out.add(h);
    }
  }
};

/** Every site the text says it is meant for (as written; no decoding). */
export const boundHosts = (text: string): string[] => {
  const out = new Set<string>();
  lineHosts(text, false, out);
  fieldHosts(text, false, out);
  return [...out];
};

// ---- lenient decoding ----

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  period: '.',
  colon: ':',
  sol: '/',
  bsol: '\\',
  equals: '=',
  commat: '@',
};
// \b and \f are dropped (control characters).
const JSON_ESCAPES: Record<string, string> = {
  '/': '/',
  '"': '"',
  '\\': '\\',
  "'": "'",
  t: '\t',
  n: '\n',
  r: '\r',
  b: '',
  f: '',
};
const hexVal = (c: number) =>
  c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
const isControl = (c: number) =>
  (c < 32 && c !== 9 && c !== 10 && c !== 13) || (c >= 0x7f && c <= 0x9f) || c === 0xfffd;
const utf8Lossy = (bytes: Uint8Array) => new TextDecoder('utf-8').decode(bytes);

// Control characters (C0 except tab/newline/return, DEL, C1) and U+FFFD.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffd]/g;
// What decodeOnce acts on; everything between is copied as one slice.
// eslint-disable-next-line no-control-regex
const SPECIAL_RE = /[\\%&+\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2060\ufeff\ufffd]/g;
const keep = (ch: string) => (isControl(ch.charCodeAt(0)) ? '' : ch);

/**
 * One lenient decode pass, linear: JSON / JS escapes (\u0064, \x2e, \/, \", \\, \n), runs of valid %XX decoded
 * together as UTF-8 (a stray % no longer stops the rest: review A4), '+' as a space, HTML character references, and
 * control and zero-width characters (soft hyphen, U+200B-U+200F, U+2060, BOM) dropped.
 */
export const decodeOnce = (s: string): string => {
  const n = s.length;
  const out: string[] = [];
  let last = 0;
  const re = new RegExp(SPECIAL_RE.source, 'g');
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const i = m.index;
    out.push(s.slice(last, i));
    const c = s.charCodeAt(i);
    let j = i + 1; // end of what is consumed
    let rep = '';
    if (c === 92 /* \ */ && i + 1 < n) {
      const d = s[i + 1];
      const h = (o: number) => hexVal(s.charCodeAt(i + o));
      if (d === 'u' && i + 5 < n && h(2) >= 0 && h(3) >= 0 && h(4) >= 0 && h(5) >= 0) {
        rep = keep(String.fromCharCode((h(2) << 12) | (h(3) << 8) | (h(4) << 4) | h(5)));
        j = i + 6;
      } else if (d === 'x' && i + 3 < n && h(2) >= 0 && h(3) >= 0) {
        rep = keep(String.fromCharCode((h(2) << 4) | h(3)));
        j = i + 4;
      } else if (Object.prototype.hasOwnProperty.call(JSON_ESCAPES, d)) {
        // \" and \\ too, so JSON nested in a JSON string ("{\"domain\":\"good.com\"}") reads as JSON.
        rep = JSON_ESCAPES[d];
        j = i + 2;
      } else rep = '\\';
    } else if (c === 37 /* % */) {
      // A run of %XX, decoded together as UTF-8 (so %C3%BC is one character).
      const bytes: number[] = [];
      let k = i;
      while (k + 2 < n && s.charCodeAt(k) === 37) {
        const a = hexVal(s.charCodeAt(k + 1));
        const b = hexVal(s.charCodeAt(k + 2));
        if (a < 0 || b < 0) break;
        bytes.push((a << 4) | b);
        k += 3;
      }
      if (bytes.length) j = k;
      rep = bytes.length ? utf8Lossy(Uint8Array.from(bytes)).replace(CONTROL_RE, '') : '%';
    } else if (c === 38 /* & */) {
      // At most 10 characters ahead (an unbounded indexOf here was quadratic on "&&&&...").
      let semi = -1;
      for (let k = i + 1; k < Math.min(n, i + 11); k++)
        if (s.charCodeAt(k) === 59) {
          semi = k;
          break;
        }
      const body = semi > i + 1 ? s.slice(i + 1, semi) : '';
      let ch: string | undefined;
      if (/^#\d{1,7}$/.test(body)) ch = String.fromCodePoint(Math.min(Number(body.slice(1)), 0x10ffff));
      else if (/^#x[0-9a-f]{1,6}$/i.test(body))
        ch = String.fromCodePoint(Math.min(parseInt(body.slice(2), 16), 0x10ffff));
      else if (body) ch = NAMED_ENTITIES[body.toLowerCase()];
      if (ch !== undefined) {
        rep = keep(ch);
        j = semi + 1;
      } else rep = '&';
    } else if (c === 43 /* + */) rep = ' ';
    // else: a control character, dropped.
    out.push(rep);
    last = j;
    re.lastIndex = j;
  }
  if (last === 0) return s;
  out.push(s.slice(last));
  return out.join('');
};

/**
 * The two readings of a byte string: junk (invalid UTF-8, control bytes) as spaces, so a host after a junk byte
 * still starts a word; and control bytes dropped, so a name split by NULs or written as UTF-16 joins up.
 */
export const readings = (bytes: Uint8Array): string[] => {
  const spaced = utf8Lossy(bytes).replace(CONTROL_RE, ' ');
  const kept = bytes.filter((b) => !(b < 32 && b !== 9 && b !== 10 && b !== 13) && b !== 0x7f);
  const joined = utf8Lossy(kept).replace(CONTROL_RE, '');
  return spaced === joined ? [spaced] : [spaced, joined];
};

// '=' only as padding at the end, so "token=<base64>" yields the base64 (review A3: it yielded nothing before).
const TOKEN_RE = /[A-Za-z0-9+/_-]{16,}={0,2}/g;
const B64_RE = /^[A-Za-z0-9+/_-]{16,}={0,2}$/;
const HEX_RE = /^(?:[0-9a-fA-F]{2}){8,}$/;
const tokenBytes = (tok: string): Uint8Array | null => {
  if (HEX_RE.test(tok)) return Uint8Array.from(tok.match(/../g)!, (h) => parseInt(h, 16));
  if (!B64_RE.test(tok)) return null;
  try {
    const b = atob(
      tok
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(tok.length / 4) * 4, '='),
    );
    return Uint8Array.from(b, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
};

// ---- AuthFetch (BRC-104) frames ----

/** Bitcoin varint; -1 for the 0xff x 9 "absent" marker; null when malformed or larger than the data. */
const readVarInt = (b: Uint8Array, at: { i: number }): number | null => {
  if (at.i >= b.length) return null;
  const first = b[at.i++];
  const take = first < 0xfd ? 0 : first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
  if (at.i + take > b.length) return null;
  if (take === 0) return first;
  const bytes = b.subarray(at.i, at.i + take);
  at.i += take;
  if (take === 8 && bytes.every((x) => x === 0xff)) return -1;
  let v = 0;
  for (let k = take - 1; k >= 0; k--) v = v * 256 + bytes[k];
  return v <= b.length ? v : null;
};
const readBytes = (b: Uint8Array, at: { i: number }, optional: boolean): Uint8Array | null | undefined => {
  const len = readVarInt(b, at);
  if (len === null || (len === -1 && !optional) || (len !== -1 && at.i + len > b.length)) return undefined;
  if (len === -1) return null;
  const out = b.subarray(at.i, at.i + len);
  at.i += len;
  return out;
};
const ascii = (b: Uint8Array) => String.fromCharCode(...b);
const HEADER_KEY = /^(?:content-type|authorization|x-bsv-[a-z0-9-]+)$/;
const readHeaders = (b: Uint8Array, at: { i: number }) => {
  const count = readVarInt(b, at);
  if (count === null || count < 0 || count > 64) return false;
  for (let h = 0; h < count; h++) {
    const key = readBytes(b, at, false);
    if (!key || key.length > 64 || !HEADER_KEY.test(ascii(key))) return false;
    if (readBytes(b, at, false) === undefined) return false;
  }
  return true;
};

/**
 * The readable parts (path, query, body) of exactly one AuthFetch request (`serializeRequest`: 32-byte nonce, method,
 * path, search, headers, body) or response (32-byte request id, status, headers, body) frame; null when the data is
 * not one.
 */
export const authFetchParts = (b: Uint8Array): { text: string[]; body: Uint8Array | null } | null => {
  if (b.length < 32 + 4) return null;
  // Request.
  {
    const at = { i: 32 };
    const m = readBytes(b, at, false);
    const method = m && m.length <= 16 ? ascii(m) : '';
    const path = /^[A-Z]{1,16}$/.test(method) ? readBytes(b, at, true) : undefined;
    const search = path !== undefined ? readBytes(b, at, true) : undefined;
    const pathOk = path === null || (!!path && path[0] === 0x2f);
    const searchOk = search === null || (!!search && search[0] === 0x3f);
    if (path !== undefined && search !== undefined && pathOk && searchOk && readHeaders(b, at)) {
      const body = readBytes(b, at, true);
      if (body !== undefined && at.i === b.length)
        return { text: [path ? utf8Lossy(path) : '', search ? utf8Lossy(search) : ''], body };
    }
  }
  // Response.
  {
    const at = { i: 32 };
    const status = readVarInt(b, at);
    if (status !== null && status >= 100 && status <= 599 && readHeaders(b, at)) {
      const body = readBytes(b, at, true);
      if (body !== undefined && at.i === b.length) return { text: [], body };
    }
  }
  return null;
};

// ---- the scan ----

/** Most characters one call reads, across every reading, decode pass, decoded token and inflated stream (1M). */
export const MAX_SCAN_CHARS = 1 << 20;
const BINDING_COST = 64;
const MAX_DEPTH = 2; // decoded tokens, and tokens inside those
// Decoded tokens are read together, one buffer per string, split by a line that no host pattern crosses.
const TOKEN_SEP = [10, 124, 10]; // "\n|\n"
// Up to this many lenient decode passes (each stops early once nothing changes): layered %25 encodings.
const DECODE_PASSES = 8;

type Budget = { chars: number; tokens: Set<string>; exhausted: boolean };

const decodedTokens = (s: string, budget: Budget): Uint8Array | null => {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const m of s.matchAll(TOKEN_RE)) {
    const tok = m[0];
    if (budget.tokens.has(tok)) continue;
    budget.tokens.add(tok);
    const b = tokenBytes(tok);
    if (b?.length) {
      parts.push(b);
      total += b.length + TOKEN_SEP.length;
    }
  }
  if (!parts.length) return null;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    out.set(TOKEN_SEP, at + p.length);
    at += p.length + TOKEN_SEP.length;
  }
  return out;
};

const scanString = (s: string, depth: number, lenient: boolean, budget: Budget, out: Set<string>) => {
  let cur = s;
  for (let pass = 0; pass <= DECODE_PASSES && !budget.exhausted; pass++) {
    if (budget.chars + cur.length > MAX_SCAN_CHARS) {
      budget.exhausted = true;
      return;
    }
    budget.chars += cur.length;
    lineHosts(cur, lenient, out);
    // A binding field costs far more than a character (several URL readings), so crafted input packed with them
    // (thousands of url=... across eight decode passes) runs out of budget instead of taking 80+ ms.
    budget.chars += fieldHosts(cur, lenient, out) * BINDING_COST;
    if (budget.chars > MAX_SCAN_CHARS) {
      budget.exhausted = true;
      return;
    }
    if (depth < MAX_DEPTH) {
      const bytes = decodedTokens(cur, budget);
      if (bytes) scanBytes(bytes, depth + 1, budget, out);
      if (budget.exhausted) return;
    }
    const next = decodeOnce(cur);
    if (next === cur) return;
    cur = next;
  }
};

/** Valid UTF-8 and at least 90% printable: text, read with the strict host rules. */
const isText = (bytes: Uint8Array) => {
  let t: string;
  try {
    t = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  if (!t) return false;
  const junk = t.match(CONTROL_RE)?.length ?? 0;
  return (t.length - junk) / t.length >= 0.9;
};

// Gzip and zlib data is inflated (review A3), at most MAX_INFLATE bytes, fed in small pieces so a decompression bomb
// stops after one piece's worth of output. More than that can't be read in full, so it counts as unreadable (the guard
// refuses). Raw deflate has no header to recognise and is not read.
const MAX_INFLATE = 256 * 1024;
const INFLATE_STEP = 256;
export const inflateBounded = (b: Uint8Array): { bytes: Uint8Array; truncated: boolean } | null => {
  const gzip = b.length > 18 && b[0] === 0x1f && b[1] === 0x8b && b[2] === 8;
  const zlib = b.length > 6 && (b[0] & 0x0f) === 8 && b[0] >> 4 <= 7 && ((b[0] << 8) | b[1]) % 31 === 0;
  if (!gzip && !zlib) return null;
  const parts: Uint8Array[] = [];
  let total = 0;
  let extra = 0; // output past MAX_INFLATE, counted and dropped
  try {
    const stream = gzip ? new Gunzip() : new Unzlib();
    stream.ondata = (chunk: Uint8Array) => {
      const take = chunk.subarray(0, Math.max(0, MAX_INFLATE - total));
      extra += chunk.length - take.length;
      if (take.length) parts.push(take.slice());
      total += take.length;
    };
    // Past the cap, keep feeding a little longer (at most MAX_EXTRA more output) to see whether the stream is real:
    // random bytes that happen to look like a zlib header break down soon and are read as what came out
    // (review N4); a real stream that is still going is too big to read and counts as truncated.
    for (let i = 0; i < b.length && extra <= MAX_EXTRA; i += INFLATE_STEP)
      stream.push(b.subarray(i, i + INFLATE_STEP), i + INFLATE_STEP >= b.length);
  } catch {
    if (!total) return null;
    return { bytes: join(parts, total), truncated: false };
  }
  if (!total) return null;
  return { bytes: join(parts, total), truncated: extra > 0 };
};
const MAX_EXTRA = 1 << 20;
const join = (parts: Uint8Array[], total: number) => {
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

function scanBytes(bytes: Uint8Array, depth: number, budget: Budget, out: Set<string>) {
  const lenient = !isText(bytes);
  for (const r of readings(bytes)) {
    scanString(r, depth, lenient, budget, out);
    if (budget.exhausted) return;
  }
  if (depth < MAX_DEPTH) {
    const inflated = inflateBounded(bytes);
    if (inflated?.truncated) budget.exhausted = true;
    else if (inflated) scanBytes(inflated.bytes, depth + 1, budget, out);
  }
}

/**
 * Every site `data` names, read every way above. `exhausted`: the data needed more reading than MAX_SCAN_CHARS (only
 * crafted input does), so the answer is incomplete and the caller must not sign.
 *
 * `authMessage`: the call signs under protocol [2, 'auth message signature'], which is every @bsv/sdk Peer (BRC-103)
 * signature. Such a signature only verifies at a BRC-103 peer, which never reads site names (review N2), so an exact
 * AuthFetch (BRC-104) request or response frame under it names no site, whatever its body says (a profile's website, a
 * DNS record's host, ?domain=). Under any other protocol a frame is just bytes and is read whole, nonce and headers
 * included.
 */
export const scanSignData = (
  data: Uint8Array,
  opts: { authMessage?: boolean } = {},
): { hosts: string[]; exhausted: boolean; frame: boolean; chars: number } => {
  if (opts.authMessage && authFetchParts(data)) return { hosts: [], exhausted: false, frame: true, chars: 0 };
  const budget: Budget = { chars: 0, tokens: new Set(), exhausted: false };
  const out = new Set<string>();
  scanBytes(data, 0, budget, out);
  return { hosts: [...out], exhausted: budget.exhausted, frame: false, chars: budget.chars };
};
