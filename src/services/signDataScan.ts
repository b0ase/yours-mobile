/**
 * Which sites a piece of data to be signed names (used by crossSiteSignGuard.ts).
 *
 * b-Aware triage and review, 13 Nov 2026. The guard reads whatever an outside site asks it to sign, before any prompt,
 * so this must be cheap on every input and must read the data the way a lenient verifier at the named site could:
 * - Linear work only. No regex here has overlapping quantifiers on attacker-sized runs; fields are found by a
 *   tokeniser, not a backtracking regex; and the whole scan has a character budget (MAX_SCAN_CHARS). Past it the scan
 *   stops and says so, and the guard refuses rather than signs.
 * - Every byte string is read twice: with junk (invalid UTF-8, control bytes) as spaces, and with control bytes
 *   dropped, which also reads ASCII sent as UTF-16 or split by NULs ("go\x01od.com"). Plain text reads once.
 * - Each reading is also read after a lenient decode pass (JSON \u and \x escapes, valid %XX runs, HTML entities),
 *   up to three passes for double encoding, and base64 / hex tokens are decoded and read the same way, two levels deep.
 * - An AuthFetch (BRC-104) request or response frame is recognised and read by part: its path, query and body.
 *   Its header values (authorization bearer tokens) are not read. Inside a frame, URL-shaped fields (url, uri, origin,
 *   redirect, callback, return_to, *_url ...) are ordinary request content (an image URL, a webhook, a link preview)
 *   and do not bind; domain / host / audience / realm / relying-party fields and login lines still do.
 * - Gzip and zlib data is inflated, bounded (raw deflate has no header and is not read).
 * Not read: raw deflate, other compression, and IDN hosts written in Unicode inside login lines (they are read in
 * fields).
 */

import { Gunzip, Unzlib } from 'fflate';

// Keys that say which site a message is for. uri/url/site/callback/redirect shapes added after the b-Aware
// report of 24 Oct 2026 (b_feedback 51): a sign-in message naming its site through one of these was not checked.
const STRONG_KEYS = [
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
];
const URL_KEYS = [
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
];
const STRONG_SET = new Set(STRONG_KEYS);
const ALL_SET = new Set([...STRONG_KEYS, ...URL_KEYS]);
// b-Aware 29 Oct 2026 (squ11z1): camelCase and kebab-case keys (redirectUrl, callbackUrl, returnTo, rpId,
// relyingParty, redirect-uri) were never seen. Every key is normalised to snake_case first; a key in the list, or
// ending in a site-ish word (login_url, app_origin, expected_domain, post_login_redirect), binds.
const ALL_SUFFIX =
  /(?:^|_)(?:url|uri|origin|domain|host|hostname|audience|redirect|callback|return_to|realm|rp_id|relying_party)$/;
const STRONG_SUFFIX = /(?:^|_)(?:domain|host|hostname|audience|realm|rp_id|relying_party)$/;

/** camelCase / PascalCase / kebab-case / snake_case key to one snake_case form. */
export const normaliseKey = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();

/** 'all': every binding key (text, raw binary). 'frame': inside an AuthFetch frame, URL-shaped keys don't bind. */
export type KeyMode = 'all' | 'frame';
const MAX_KEY = 64;
const isBindingKey = (key: string, mode: KeyMode) => {
  if (key.length > MAX_KEY) return false;
  const set = mode === 'all' ? ALL_SET : STRONG_SET;
  const suffix = mode === 'all' ? ALL_SUFFIX : STRONG_SUFFIX;
  // Also the plain lower-case key: "DoMaIn" normalises to do_ma_in.
  for (const k of new Set([normaliseKey(key), key.toLowerCase().replace(/-/g, '_')]))
    if (set.has(k) || suffix.test(k)) return true;
  return false;
};

// "<host> wants you to sign in" (SIWE), "<host> wallet login:" and "Sign in to <host>" lines, anywhere in the
// text: a prefix such as "Login: " or a JSON string around the line must not hide it.
// Also IPv4 literals and "localhost" (b-Aware 25 Oct 2026, Widia): a challenge for 10.0.0.5 named no site before.
// Labels are separated by a dot that the label class excludes, so a run of labels backtracks in linear time.
const HOST = '((?:(?:[a-z0-9-]+\\.)+[a-z]{2,}|(?:\\d{1,3}\\.){3}\\d{1,3}|localhost)(?::\\d+)?)';
// b-Aware 28 Oct 2026 (Jacob Anderson, 0qu5xz): "Sign into", "Log onto", "good.com - sign in", "Welcome to good.com"
// and similar wordings named no site, so another site got the login signature.
const SEP = '[\\s,:–—-]*';
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
// WHATWG "special" schemes: after "https:" any run of / or \ (even none) starts the host.
const SPECIAL = new Set(['http', 'https', 'ws', 'wss', 'ftp', 'file']);
const MAX_VALUE = 1024;

/**
 * Lower-case hostname with no port, no trailing dot and no pairing suffix (".c<hex>.paired.invalid"). Read the way a
 * WHATWG URL parser would (review 13 Nov 2026, A4): tabs and newlines dropped, backslashes as slashes, "https:good.com",
 * "https:/good.com" and "//good.com" all name good.com; a Unicode or percent-encoded host is converted (punycode).
 */
export const bareHost = (value: string): string | null => {
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
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]|%/.test(v)) {
    try {
      v = new URL(`http://${v}`).hostname;
    } catch {
      return null;
    }
  }
  v = v.replace(/\.$/, '').replace(/(\.c[0-9a-f]{44})?\.paired\.invalid$/, '');
  return HOST_RE.test(v) ? v : null;
};

const isKeyStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95; // A-Z a-z _
const isKeyChar = (c: number) => isKeyStart(c) || (c >= 48 && c <= 57) || c === 45; // + 0-9 -
const isSpace = (c: number) => c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x85;
const isQuote = (c: number) => c === 34 || c === 39 || c === 96;
// A value ends at white space, quotes, separators, or the start of a query / next form field (so "a=1&domain=x" reads
// both fields: the old regex took "1&domain=x" as one value).
const STOPS = new Set([...'"\'`,;}]&?#<>|'].map((c) => c.charCodeAt(0)));
const isStop = (c: number) => isSpace(c) || STOPS.has(c);

/**
 * key[:=]value pairs, found in one left-to-right pass (each character is looked at a fixed number of times). Same
 * shape as the old `["']?(key)["']?\s*[:=]\s*["']?(value)` regex, which backtracked quadratically on long words.
 */
const fieldHosts = (s: string, mode: KeyMode, out: Set<string>) => {
  const n = s.length;
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
    if (j < n && isQuote(s.charCodeAt(j))) j++;
    while (j < n && isSpace(s.charCodeAt(j))) j++;
    if (j >= n || (s.charCodeAt(j) !== 58 && s.charCodeAt(j) !== 61)) continue; // ':' or '='
    j++;
    while (j < n && isSpace(s.charCodeAt(j))) j++;
    if (j < n && isQuote(s.charCodeAt(j))) j++;
    const v = j;
    while (j < n && !isStop(s.charCodeAt(j))) j++;
    if (j > v && isBindingKey(s.slice(k, i), mode)) {
      const value = s.slice(v, Math.min(j, v + MAX_VALUE));
      let h = bareHost(value);
      // A URL parser drops tabs and newlines, so "https://go<TAB>od.com" names good.com (review A4). Only when the
      // part before the break names no host: in "Origin: https://a.com<LF>Nonce: 1" the line break ends the value.
      if (!h && /^(?:[a-z][a-z0-9+.-]*:)?[/\\]{2}[^/\\?#]*$/i.test(value)) {
        let e = j;
        while (e < n && (s.charCodeAt(e) === 9 || s.charCodeAt(e) === 10 || s.charCodeAt(e) === 13)) e++;
        if (e > j) {
          let f = e;
          while (f < n && !isStop(s.charCodeAt(f))) f++;
          if (f > e) h = bareHost(value + s.slice(e, Math.min(f, e + MAX_VALUE)));
        }
      }
      if (h) out.add(h);
    }
    // Carry on after the value (like a global regex), so a long value is read once.
    i = Math.max(j, i);
  }
};

// Every login line contains one of these words; most data contains none, so the line regexes are skipped.
const LINE_WORDS = /sign|log|wants|requ|welcome|authent|verify|authori|connect|continue/i;
const lineHosts = (s: string, out: Set<string>) => {
  if (!LINE_WORDS.test(s)) return;
  for (const re of SIGN_IN_LINES) {
    for (const m of s.matchAll(re)) {
      const h = bareHost(m[1]);
      if (h) out.add(h);
    }
  }
};

/** Every site the text says it is meant for (as written; no decoding). */
export const boundHosts = (text: string, mode: KeyMode = 'all'): string[] => {
  const out = new Set<string>();
  lineHosts(text, out);
  fieldHosts(text, mode, out);
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
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f�]/g;
// What decodeOnce acts on; everything between is copied as one slice.
// eslint-disable-next-line no-control-regex
const SPECIAL_RE = /[\\%&+\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f�]/g;
const keep = (ch: string) => (isControl(ch.charCodeAt(0)) ? '' : ch);

/**
 * One lenient decode pass, linear: JSON / JS escapes (d, \x2e, \/, \", \\, \n), runs of valid %XX decoded
 * together as UTF-8 (a stray % no longer stops the rest: review A4), '+' as a space, HTML character references, and
 * control characters dropped.
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
 * not one. Header values are skipped.
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

/** Most characters one call reads, across every reading, decode pass and decoded token (8 x 64 KB). */
export const MAX_SCAN_CHARS = 1 << 19;
const MAX_DEPTH = 2; // decoded tokens, and tokens inside those
// Decoded tokens are read together, one buffer per string, split by a line that no host pattern crosses.
const TOKEN_SEP = [10, 124, 10]; // "\n|\n"
const DECODE_PASSES = 3;

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

const scanString = (s: string, depth: number, mode: KeyMode, budget: Budget, out: Set<string>) => {
  let cur = s;
  for (let pass = 0; pass <= DECODE_PASSES && !budget.exhausted; pass++) {
    if (budget.chars + cur.length > MAX_SCAN_CHARS) {
      budget.exhausted = true;
      return;
    }
    budget.chars += cur.length;
    lineHosts(cur, out);
    fieldHosts(cur, mode, out);
    if (depth < MAX_DEPTH) {
      const bytes = decodedTokens(cur, budget);
      if (bytes) scanBytes(bytes, depth + 1, mode, budget, out);
      if (budget.exhausted) return;
    }
    const next = decodeOnce(cur);
    if (next === cur) return;
    cur = next;
  }
};

// Gzip and zlib data is inflated (review A3), at most MAX_INFLATE bytes, fed in small pieces so a decompression bomb
// stops after one piece's worth of output. More than that can't be read in full, so it counts as unreadable (the guard
// refuses). Raw deflate has no header to recognise and is not read.
const MAX_INFLATE = 64 * 1024;
const INFLATE_STEP = 256;
export const inflateBounded = (b: Uint8Array): { bytes: Uint8Array; truncated: boolean } | null => {
  const gzip = b.length > 18 && b[0] === 0x1f && b[1] === 0x8b && b[2] === 8;
  const zlib = b.length > 6 && (b[0] & 0x0f) === 8 && b[0] >> 4 <= 7 && ((b[0] << 8) | b[1]) % 31 === 0;
  if (!gzip && !zlib) return null;
  const parts: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    const stream = gzip ? new Gunzip() : new Unzlib();
    stream.ondata = (chunk: Uint8Array) => {
      const take = chunk.subarray(0, MAX_INFLATE - total);
      if (take.length < chunk.length) truncated = true;
      if (take.length) parts.push(take.slice());
      total += take.length;
    };
    for (let i = 0; i < b.length && !truncated; i += INFLATE_STEP)
      stream.push(b.subarray(i, i + INFLATE_STEP), i + INFLATE_STEP >= b.length);
  } catch {
    /* corrupt or not really compressed: read what came out */
  }
  if (!total) return null;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return { bytes: out, truncated };
};

function scanBytes(bytes: Uint8Array, depth: number, mode: KeyMode, budget: Budget, out: Set<string>) {
  for (const r of readings(bytes)) {
    scanString(r, depth, mode, budget, out);
    if (budget.exhausted) return;
  }
  if (depth < MAX_DEPTH) {
    const inflated = inflateBounded(bytes);
    if (inflated?.truncated) budget.exhausted = true;
    else if (inflated) scanBytes(inflated.bytes, depth + 1, mode, budget, out);
  }
}

/**
 * Every site `data` names, read every way above. `exhausted`: the data needed more reading than MAX_SCAN_CHARS (only
 * crafted input does), so the answer is incomplete and the caller must not sign.
 */
export const scanSignData = (
  data: Uint8Array,
): { hosts: string[]; exhausted: boolean; frame: boolean; chars: number } => {
  const budget: Budget = { chars: 0, tokens: new Set(), exhausted: false };
  const out = new Set<string>();
  const frame = authFetchParts(data);
  if (frame) {
    for (const t of frame.text) if (t) scanString(t, 0, 'frame', budget, out);
    if (frame.body?.length && !budget.exhausted) scanBytes(frame.body, 0, 'frame', budget, out);
  } else scanBytes(data, 0, 'all', budget, out);
  return { hosts: [...out], exhausted: budget.exhausted, frame: !!frame, chars: budget.chars };
};
