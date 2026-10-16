// Sign in with bWalletX: an OAuth 2.1 + PKCE authorization server (docs/SIGN-IN-WITH-BWALLETX.md).
//
//   GET  /authorize                         → a page that opens the wallet (deep link / web wallet / extension)
//   GET  /api/auth/request?id=              → what the wallet shows on its approval sheet (public, no secrets)
//   POST /api/auth/approve | /api/auth/deny → the wallet's answer, signed by the identity key (BRC-100 createSignature)
//   GET  /api/auth/status?id=               → the /authorize page polls; only that browser (cookie) gets the code
//   POST /token                             → code + PKCE verifier → id_token + access_token (ES256 JWT, 10 min)
//   GET  /userinfo                          → claims for a Bearer access token
//   GET  /.well-known/openid-configuration, /.well-known/jwks.json
//
// Env (Vercel only, never in git):
//   BWALLETX_AUTH_SIGNING_KEY  ES256 (P-256) private key, PKCS#8 PEM. "\n" escapes are accepted.
//   BWALLETX_AUTH_ISSUER       optional, default https://auth.bwalletx.com
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (requests table: migrations/20261016_bwallet_auth_requests.sql)
//   BITSIGN_PUBLIC_URL         optional, for the bitsign_level claim
'use strict';
const crypto = require('crypto');
const { ProtoWallet, Utils } = require('@bsv/sdk');
const { CLIENTS } = require('./authClients');

const SIGN_PROTOCOL = [2, 'bwalletx auth'];
const SIGN_KEY_ID = '1';
const PUBKEY_RE = /^0[23][0-9a-f]{64}$/;
const ID_RE = /^[0-9a-f]{32}$/;
const REQUEST_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 2 * 60_000;
const TOKEN_TTL_S = 600;
const SIG_WINDOW_MS = 5 * 60_000;
const SCOPES = ['openid', 'profile', 'paymail', 'bitsign'];
const DEFAULT_ISSUER = 'https://auth.bwalletx.com';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const sha256hex = (s) => sha256(s).toString('hex');
const randHex = (n) => crypto.randomBytes(n).toString('hex');

/** RFC 7636 S256: BASE64URL(SHA256(ascii(verifier))) === challenge. Verifier: 43-128 unreserved chars. */
function pkceOk(verifier, challenge) {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return false;
  const a = Buffer.from(b64url(sha256(verifier)));
  const b = Buffer.from(challenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The exact string the wallet signs. Field order is fixed (sorted). */
function authMessage(action, fields) {
  const keys = Object.keys(fields).sort();
  return ['bwalletx-auth', 'v1', action, ...keys.map((k) => `${k}=${fields[k] ?? ''}`)].join('|');
}

/** Fields bound into the signature: the request, the app and where the code goes. */
const signedFields = (row, identityKey, timestamp) => ({
  id: row.id,
  client_id: row.client_id,
  redirect_uri: row.redirect_uri,
  identityKey,
  timestamp: String(timestamp),
});

/** Verify `body.signature` (hex DER) by `body.identityKey` over authMessage(action, …). Returns an error or null. */
async function verifyAuthSignature(body, row, action, now = Date.now()) {
  const identityKey = String(body.identityKey || '').toLowerCase();
  if (!PUBKEY_RE.test(identityKey)) return 'Invalid identity key';
  const ts = Number(body.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > SIG_WINDOW_MS) return 'Signature expired; check your clock';
  if (!/^[0-9a-f]{16,200}$/i.test(String(body.signature || ''))) return 'Missing signature';
  try {
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: Utils.toArray(authMessage(action, signedFields(row, identityKey, ts)), 'utf8'),
      signature: Utils.toArray(String(body.signature), 'hex'),
      protocolID: SIGN_PROTOCOL,
      keyID: SIGN_KEY_ID,
      counterparty: identityKey,
    });
    return valid ? null : 'Bad signature';
  } catch {
    return 'Bad signature';
  }
}

// ─── ES256 JWT ──────────────────────────────────────────────

/** The signing key from env, or null. Never a default: no key, no tokens. */
function loadSigningKey(env = process.env) {
  const pem = String(env.BWALLETX_AUTH_SIGNING_KEY || '')
    .replace(/\\n/g, '\n')
    .trim();
  if (!pem) return null;
  const priv = crypto.createPrivateKey(pem);
  if (priv.asymmetricKeyType !== 'ec' || priv.asymmetricKeyDetails?.namedCurve !== 'prime256v1')
    throw new Error('BWALLETX_AUTH_SIGNING_KEY must be a P-256 (ES256) key');
  const pub = crypto.createPublicKey(priv);
  const jwk = pub.export({ format: 'jwk' });
  // RFC 7638 thumbprint as kid.
  const kid = b64url(sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))).slice(0, 16);
  return { priv, pub, jwk: { ...jwk, kid, alg: 'ES256', use: 'sig' }, kid };
}

function signJwt(key, payload, typ = 'JWT') {
  const head = b64url(JSON.stringify({ alg: 'ES256', typ, kid: key.kid }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: key.priv, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64url(sig)}`;
}

/** Verify our own JWT. Returns the payload or null. */
function verifyJwt(key, token, { typ, issuer, now = Date.now() } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const head = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (head.alg !== 'ES256' || head.kid !== key.kid || (typ && head.typ !== typ)) return null;
    const ok = crypto.verify(
      'sha256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      { key: key.pub, dsaEncoding: 'ieee-p1363' },
      Buffer.from(parts[2], 'base64url'),
    );
    if (!ok) return null;
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (issuer && p.iss !== issuer) return null;
    if (!(p.exp * 1000 > now)) return null;
    return p;
  } catch {
    return null;
  }
}

// ─── stores ─────────────────────────────────────────────────

/** In-memory store (tests, local dev). Same contract as supabaseAuthStore. */
function memoryAuthStore() {
  const rows = new Map();
  return {
    rows,
    insert: async (row) => void rows.set(row.id, { ...row }),
    get: async (id) => (rows.has(id) ? { ...rows.get(id) } : null),
    /** Update only when the row still has status `from` (atomic in PostgREST). Returns the new row or null. */
    transition: async (id, from, patch) => {
      const r = rows.get(id);
      if (!r || r.status !== from) return null;
      Object.assign(r, patch);
      return { ...r };
    },
    /** Burn a code: issued → used, once. Returns the row or null (unknown or already used). */
    consumeCode: async (codeHash) => {
      for (const r of rows.values())
        if (r.code_hash === codeHash && r.status === 'issued') {
          r.status = 'used';
          return { ...r };
        }
      return null;
    },
  };
}

function supabaseAuthStore(env = process.env, f = fetch) {
  const url = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const T = 'bwallet_auth_requests';
  const q = encodeURIComponent;
  const req = async (path, init = {}) => {
    const r = await f(`${url}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(init.headers || {}),
      },
    });
    if (!r.ok) throw new Error(`supabase ${r.status}`);
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  };
  return {
    insert: async (row) => void (await req(T, { method: 'POST', body: JSON.stringify(row) })),
    get: async (id) => (await req(`${T}?id=eq.${q(id)}&limit=1`))?.[0] ?? null,
    transition: async (id, from, patch) =>
      (await req(`${T}?id=eq.${q(id)}&status=eq.${q(from)}`, { method: 'PATCH', body: JSON.stringify(patch) }))?.[0] ??
      null,
    consumeCode: async (codeHash) =>
      (
        await req(`${T}?code_hash=eq.${q(codeHash)}&status=eq.issued`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'used' }),
        })
      )?.[0] ?? null,
  };
}

// ─── claims helpers ─────────────────────────────────────────

/** bit-sign identity strength (1-4+) for a handle this key owns, or null. Public endpoints, fail quiet. */
async function bitsignLevel(alias, identityKey, env = process.env, f = fetch) {
  if (!alias) return null;
  const base = String(env.BITSIGN_PUBLIC_URL || 'https://www.bitcoinchat.online').replace(/\/$/, '');
  try {
    const own = await f(
      `${base}/api/public/handles/owner?handle=${encodeURIComponent(alias)}&key=${encodeURIComponent(identityKey)}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(3000) },
    );
    if (!own.ok || (await own.json())?.matches !== true) return null;
    const r = await f(`${base}/api/public/profile/${encodeURIComponent(alias)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return null;
    const n = Number((await r.json())?.identityStrength);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  } catch {
    return null;
  }
}

// ─── handlers ───────────────────────────────────────────────

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function parseScope(s) {
  const want = String(s || 'openid')
    .split(/\s+/)
    .filter(Boolean);
  if (!want.includes('openid')) want.unshift('openid');
  const bad = want.find((w) => !SCOPES.includes(w));
  return bad ? { error: `unknown scope ${bad}` } : { scope: [...new Set(want)].join(' ') };
}

function redirectWith(uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
  return u.toString();
}

/**
 * makeAuth({ store, env, clients, now, lookupAlias, level }) → handlers returning
 *   { status, json? , html?, headers? , redirect? }
 * lookupAlias(identityKey) → { alias, domain } | null (the paymail store); level(alias, key) → number | null.
 */
function makeAuth({
  store,
  env = process.env,
  clients = CLIENTS,
  now = () => Date.now(),
  lookupAlias = async () => null,
  level = async () => null,
  key = loadSigningKey(env),
} = {}) {
  const issuer = String(env.BWALLETX_AUTH_ISSUER || DEFAULT_ISSUER).replace(/\/$/, '');
  const live = (row) => row && Date.parse(row.expires_at) > now();

  const discovery = () => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    userinfo_endpoint: `${issuer}/userinfo`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['ES256'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: SCOPES,
    claims_supported: [
      'sub',
      'identity_key',
      'paymail',
      'handle',
      'preferred_username',
      'bitsign_level',
      'nonce',
      'auth_time',
    ],
  });

  return {
    issuer,
    discovery: async () => ({ status: 200, json: discovery() }),
    jwks: async () => ({ status: key ? 200 : 503, json: key ? { keys: [key.jwk] } : { error: 'not-configured' } }),

    /** GET /authorize. Errors before the redirect URI is trusted are shown, never redirected (RFC 6749 §4.1.2.1). */
    authorize: async (q) => {
      const client = clients[q.client_id];
      if (!client) return { status: 400, html: errorPage('Unknown app (client_id).') };
      if (!client.redirectUris.includes(q.redirect_uri))
        return { status: 400, html: errorPage('That redirect_uri is not registered for this app.') };
      const fail = (error, desc) => ({
        status: 302,
        redirect: redirectWith(q.redirect_uri, { error, error_description: desc, state: q.state }),
      });
      if (q.response_type !== 'code') return fail('unsupported_response_type', 'response_type must be code');
      if (q.code_challenge_method !== 'S256') return fail('invalid_request', 'PKCE S256 is required');
      if (!/^[A-Za-z0-9_-]{43}$/.test(String(q.code_challenge || '')))
        return fail('invalid_request', 'code_challenge must be 43 base64url chars');
      const sc = parseScope(q.scope);
      if (sc.error) return fail('invalid_scope', sc.error);
      if (!key || !store) return fail('temporarily_unavailable', 'sign-in is not configured yet');
      const id = randHex(16);
      const poll = randHex(24);
      await store.insert({
        id,
        client_id: q.client_id,
        redirect_uri: q.redirect_uri,
        scope: sc.scope,
        state: String(q.state || '').slice(0, 512) || null,
        nonce: String(q.nonce || '').slice(0, 256) || null,
        code_challenge: q.code_challenge,
        poll_hash: sha256hex(poll),
        status: 'pending',
        created_at: new Date(now()).toISOString(),
        expires_at: new Date(now() + REQUEST_TTL_MS).toISOString(),
      });
      return {
        status: 200,
        html: authorizePage({ id, issuer, client }),
        headers: {
          'Set-Cookie': `bwx_auth=${id}.${poll}; Path=/; Max-Age=${REQUEST_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Lax`,
          'Referrer-Policy': 'no-referrer',
          'X-Frame-Options': 'DENY',
          'Content-Security-Policy':
            "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'",
        },
      };
    },

    /** GET /api/auth/request?id= — the wallet's sheet. Nothing secret: no state, no challenge, no code. */
    request: async (q) => {
      if (!ID_RE.test(String(q.id || ''))) return { status: 400, json: { error: 'bad-id' } };
      const row = await store.get(q.id);
      if (!live(row)) return { status: 404, json: { error: 'This sign-in has expired. Start again on the site.' } };
      const client = clients[row.client_id];
      return {
        status: 200,
        json: {
          id: row.id,
          status: row.status,
          client: { id: row.client_id, name: client?.name ?? row.client_id, site: client?.site ?? '' },
          redirect_uri: row.redirect_uri,
          redirectHost: new URL(row.redirect_uri).host,
          scopes: row.scope.split(' '),
          expiresAt: row.expires_at,
        },
      };
    },

    /** POST /api/auth/approve { id, identityKey, timestamp, signature } */
    approve: async (body) => {
      if (!ID_RE.test(String(body?.id || ''))) return { status: 400, json: { error: 'bad-id' } };
      const row = await store.get(body.id);
      if (!live(row)) return { status: 404, json: { error: 'This sign-in has expired. Start again on the site.' } };
      if (row.status !== 'pending') return { status: 409, json: { error: 'This sign-in was already answered.' } };
      const err = await verifyAuthSignature(body, row, 'approve', now());
      if (err) return { status: 401, json: { error: err } };
      const identityKey = String(body.identityKey).toLowerCase();
      const scopes = row.scope.split(' ');
      const name = await lookupAlias(identityKey).catch(() => null);
      const lvl = scopes.includes('bitsign') && name ? await level(name.alias, identityKey).catch(() => null) : null;
      const done = await store.transition(row.id, 'pending', {
        status: 'approved',
        identity_key: identityKey,
        paymail: name ? `${name.alias}@${name.domain}` : null,
        bitsign_level: lvl,
        approved_at: new Date(now()).toISOString(),
      });
      if (!done) return { status: 409, json: { error: 'This sign-in was already answered.' } };
      return { status: 200, json: { ok: true, site: clients[row.client_id]?.site ?? '' } };
    },

    /** POST /api/auth/deny — signed too, so a stranger holding the id can't cancel someone's sign-in. */
    deny: async (body) => {
      if (!ID_RE.test(String(body?.id || ''))) return { status: 400, json: { error: 'bad-id' } };
      const row = await store.get(body.id);
      if (!live(row)) return { status: 404, json: { error: 'expired' } };
      const err = await verifyAuthSignature(body, row, 'deny', now());
      if (err) return { status: 401, json: { error: err } };
      await store.transition(row.id, 'pending', { status: 'denied' });
      return { status: 200, json: { ok: true } };
    },

    /** GET /api/auth/status?id= with the bwx_auth cookie set by /authorize. Only that browser sees the code. */
    status: async (q, cookie) => {
      const m = /(?:^|;\s*)bwx_auth=([0-9a-f]{32})\.([0-9a-f]{48})/.exec(String(cookie || ''));
      if (!m || m[1] !== q.id) return { status: 403, json: { error: 'Open the sign-in link in this browser again.' } };
      const row = await store.get(m[1]);
      if (!row || row.poll_hash !== sha256hex(m[2])) return { status: 403, json: { error: 'forbidden' } };
      if (!live(row)) return { status: 200, json: { status: 'expired' } };
      if (row.status === 'pending') return { status: 200, json: { status: 'pending' } };
      if (row.status === 'denied')
        return {
          status: 200,
          json: {
            status: 'denied',
            redirect: redirectWith(row.redirect_uri, {
              error: 'access_denied',
              error_description: 'The user said no in bWalletX',
              state: row.state,
            }),
          },
        };
      if (row.status !== 'approved') return { status: 200, json: { status: 'expired' } };
      // The code is made here, handed out once, and only its hash is stored.
      const code = b64url(crypto.randomBytes(32));
      const issued = await store.transition(row.id, 'approved', {
        status: 'issued',
        code_hash: sha256hex(code),
        expires_at: new Date(Math.min(Date.parse(row.expires_at), now() + CODE_TTL_MS)).toISOString(),
      });
      if (!issued) return { status: 200, json: { status: 'expired' } };
      return {
        status: 200,
        json: { status: 'approved', redirect: redirectWith(row.redirect_uri, { code, state: row.state, iss: issuer }) },
      };
    },

    /** POST /token (form or JSON): grant_type=authorization_code, code, redirect_uri, client_id, code_verifier. */
    token: async (b) => {
      const bad = (error, desc, status = 400) => ({ status, json: { error, error_description: desc } });
      if (!key) return bad('temporarily_unavailable', 'not configured', 503);
      if (b.grant_type !== 'authorization_code') return bad('unsupported_grant_type', 'authorization_code only');
      if (!b.code || !b.code_verifier) return bad('invalid_request', 'code and code_verifier are required');
      // Burn the code first: whatever happens next, it can never be used twice.
      const row = await store.consumeCode(sha256hex(String(b.code)));
      if (!row) return bad('invalid_grant', 'code is unknown, expired or already used');
      if (!live(row)) return bad('invalid_grant', 'code expired');
      if (row.client_id !== b.client_id) return bad('invalid_grant', 'client_id does not match');
      if (row.redirect_uri !== b.redirect_uri) return bad('invalid_grant', 'redirect_uri does not match');
      if (!pkceOk(b.code_verifier, row.code_challenge)) return bad('invalid_grant', 'PKCE verification failed');
      const t = Math.floor(now() / 1000);
      const scopes = row.scope.split(' ');
      const claims = claimsFor(row, scopes);
      const base = { iss: issuer, sub: row.identity_key, iat: t, exp: t + TOKEN_TTL_S };
      const id_token = signJwt(key, {
        ...base,
        aud: row.client_id,
        auth_time: Math.floor(Date.parse(row.approved_at) / 1000),
        ...(row.nonce ? { nonce: row.nonce } : {}),
        ...claims,
      });
      const access_token = signJwt(
        key,
        { ...base, aud: issuer, client_id: row.client_id, scope: row.scope, jti: randHex(12) },
        'at+jwt',
      );
      return {
        status: 200,
        json: { access_token, id_token, token_type: 'Bearer', expires_in: TOKEN_TTL_S, scope: row.scope },
      };
    },

    /** GET /userinfo, Authorization: Bearer <access_token>. Reads claims back from the request row. */
    userinfo: async (authz) => {
      if (!key) return { status: 503, json: { error: 'not-configured' } };
      const tok = /^Bearer\s+(.+)$/i.exec(String(authz || ''))?.[1];
      const p = tok && verifyJwt(key, tok, { typ: 'at+jwt', issuer, now: now() });
      if (!p || p.aud !== issuer)
        return { status: 401, json: { error: 'invalid_token' }, headers: { 'WWW-Authenticate': 'Bearer' } };
      // Fresh paymail lookup: the name may have changed since sign-in.
      const scopes = String(p.scope).split(' ');
      const name = await lookupAlias(p.sub).catch(() => null);
      const row = { identity_key: p.sub, paymail: name ? `${name.alias}@${name.domain}` : null, bitsign_level: null };
      if (scopes.includes('bitsign') && name) row.bitsign_level = await level(name.alias, p.sub).catch(() => null);
      return { status: 200, json: { sub: p.sub, ...claimsFor(row, scopes) } };
    },
  };
}

/** Claims by scope. openid: the identity key. profile/paymail: the $handle and paymail. bitsign: verified level. */
function claimsFor(row, scopes) {
  const out = { identity_key: row.identity_key };
  if ((scopes.includes('profile') || scopes.includes('paymail')) && row.paymail) {
    const alias = row.paymail.split('@')[0];
    out.paymail = row.paymail;
    out.handle = `$${alias}`;
    out.preferred_username = alias;
  }
  if (scopes.includes('bitsign') && row.bitsign_level != null) out.bitsign_level = row.bitsign_level;
  return out;
}

// ─── pages ──────────────────────────────────────────────────

const PAGE_CSS = `
:root{color-scheme:dark;--bg:#0b0a08;--ink:#f4efe2;--muted:#a59f8f;--gold:#e8b931;--chip:#1c1a15}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);
font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;display:flex;align-items:center;justify-content:center;padding:16px}
main{width:100%;max-width:420px}.b{width:56px;height:56px;border-radius:28px;background:var(--gold);color:var(--bg);
font-weight:800;font-size:32px;display:flex;align-items:center;justify-content:center}
h1{font-size:30px;line-height:1.1;letter-spacing:-.5px;margin:20px 0 8px}p{color:var(--muted);margin:0 0 20px}
a.btn{display:flex;align-items:center;justify-content:center;height:56px;border-radius:16px;font-weight:700;
text-decoration:none;margin-bottom:10px;font-size:18px}a.primary{background:var(--gold);color:var(--bg)}
a.alt{background:var(--chip);color:var(--ink);font-size:16px}#s{font-size:14px;margin-top:16px;min-height:20px}
`;

function errorPage(msg) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in with bWalletX</title><style>${PAGE_CSS}</style></head><body><main><div class="b">b</div>
<h1>Can't sign in</h1><p>${esc(msg)}</p></main></body></html>`;
}

function authorizePage({ id, issuer, client }) {
  const server = encodeURIComponent(issuer);
  const deep = `bwalletx://auth?id=${id}&server=${server}`;
  const web = `https://web.bwalletx.com/m/settings?bwxauth=${id}&server=${server}`;
  const ext = `${issuer}/wallet?id=${id}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in with bWalletX</title><style>${PAGE_CSS}</style></head><body><main><div class="b">b</div>
<h1>Sign in to ${esc(client.name)}</h1>
<p>Approve in bWalletX. ${esc(client.site)} gets your identity key and $name. No password, nothing paid.</p>
<a class="btn primary" href="${esc(deep)}">Open bWalletX</a>
<a class="btn alt" href="${esc(web)}" target="_blank" rel="noopener">Use the web wallet</a>
<a class="btn alt" href="${esc(ext)}" target="_blank" rel="noopener">Use the Chrome extension</a>
<p id="s" role="status">Waiting for bWalletX…</p>
<script>
(function(){var id=${JSON.stringify(id)},s=document.getElementById('s'),stop=false;
function tick(){if(stop)return;fetch('/api/auth/status?id='+id,{credentials:'same-origin',cache:'no-store'})
.then(function(r){return r.json()}).then(function(j){
if(j.redirect){stop=true;s.textContent=j.status==='approved'?'Signed in. Returning…':'Cancelled. Returning…';location.replace(j.redirect);return}
if(j.status==='expired'||j.error){stop=true;s.textContent=j.error||'This sign-in expired. Go back and start again.';return}
setTimeout(tick,1500)}).catch(function(){setTimeout(tick,3000)})}
tick();document.addEventListener('visibilitychange',function(){if(!document.hidden)tick()});})();
</script></main></body></html>`;
}

/** /wallet?id= — opened by the "Chrome extension" button; the extension's background picks the id up from the URL. */
function walletHandoffPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>bWalletX</title><style>${PAGE_CSS}</style></head><body><main><div class="b">b</div>
<h1>Approve in bWalletX</h1><p>Open the bWalletX extension (toolbar icon) to approve. Then close this tab and go back to the site.</p>
<p>No extension? <a style="color:var(--gold)" href="https://bwalletx.com/extension">Get bWalletX</a></p></main></body></html>`;
}

module.exports = {
  makeAuth,
  memoryAuthStore,
  supabaseAuthStore,
  loadSigningKey,
  signJwt,
  verifyJwt,
  pkceOk,
  authMessage,
  signedFields,
  verifyAuthSignature,
  bitsignLevel,
  walletHandoffPage,
  SIGN_PROTOCOL,
  SIGN_KEY_ID,
  SCOPES,
};
