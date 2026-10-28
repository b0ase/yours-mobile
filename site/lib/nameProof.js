// Provable names (bitcoin-corp docs/PROVABLE-NAMES.md, owner 28 Oct 2026, build step 1).
//
// A source-tagged name (`richard.gmail`) carries the provider's own signed statement: the OpenID Connect ID token
// Google returned when the owner signed in, whose `nonce` is proofNonce(the wallet's identity key). Anyone can check
// it against Google's published keys (JWKS), so we can't move the name to another key without a fresh Google-signed
// token, which only the account holder can get. We keep only the ID token: never an access or refresh token.
//
// The provider's signing keys are archived in the public name log (action 'jwks', first-seen date = the entry's
// created_at), so an old token stays checkable after Google rotates its keys.
//
// The wallet checks the same things itself (src/mobile/names/proof.ts); this copy is what the server checks before
// it stores a proof.
//
// GitHub has no signed ID token: `login.github` is proven by a public gist (checkGist below) carrying the wallet's
// signed statement. TODO (step 2): X has none either; `.x` names stay server-checked (sign-in ticket) for now.
'use strict';
const crypto = require('crypto');

/** The nonce we ask the provider to sign: sha256("bwalletx-name-proof|v1|" + identity key), hex. */
const proofNonce = (identityKey) =>
  crypto
    .createHash('sha256')
    .update(`bwalletx-name-proof|v1|${String(identityKey).toLowerCase()}`, 'utf8')
    .digest('hex');

/**
 * Providers whose ID tokens anyone can check. `suffix`: the name tag a proof proves (null: no name tag yet, so a proof
 * is accepted at sign-in but not attached to a name). `aud`: the env var holding our OAuth client id.
 */
const PROVIDERS = {
  google: {
    label: 'Google',
    iss: ['https://accounts.google.com', 'accounts.google.com'],
    jwks: 'https://www.googleapis.com/oauth2/v3/certs',
    aud: 'GOOGLE_CLIENT_ID',
    suffix: 'gmail',
  },
  linkedin: {
    label: 'LinkedIn',
    iss: ['https://www.linkedin.com/oauth'],
    jwks: 'https://www.linkedin.com/oauth/openid/jwks',
    aud: 'LINKEDIN_CLIENT_ID',
    // LinkedIn's token has no public name: `slug.linkedin` is bound to the account (sub) when claimed.
    suffix: 'linkedin',
  },
};
/** `name.gmail` → 'google'; any other name → null (not provable). */
const providerForAlias = (alias) => {
  const m = String(alias || '').match(/\.([a-z]+)$/);
  if (!m) return null;
  return Object.keys(PROVIDERS).find((p) => PROVIDERS[p].suffix === m[1]) || null;
};

// ---- GitHub gist proofs -------------------------------------------------------------------------------------------
const SIGN_PROTOCOL = [2, 'bwallet paymail'];
const SIGN_KEY_ID = '1';
const GIST_RE = /^(?:https:\/\/gist\.github\.com\/[A-Za-z0-9-]+\/)?([0-9a-f]{20,40})\/?$/;
/** The line a `name.github` owner puts in a public gist, followed by their signature of it on the next line. */
const gistStatement = (alias, identityKey) => `bwalletx-name-proof|v1|${alias}|${String(identityKey).toLowerCase()}`;
/** Check a gist's text (owner already confirmed): the statement and a valid signature by identityKey. */
async function verifyGistText(text, alias, identityKey) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim());
  const i = lines.indexOf(gistStatement(alias, identityKey));
  if (i < 0) return false;
  const sig = lines[i + 1] || '';
  if (!/^[0-9a-f]{16,200}$/i.test(sig)) return false;
  try {
    const { ProtoWallet, Utils } = require('@bsv/sdk');
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: Utils.toArray(gistStatement(alias, identityKey), 'utf8'),
      signature: Utils.toArray(sig, 'hex'),
      protocolID: SIGN_PROTOCOL,
      keyID: SIGN_KEY_ID,
      counterparty: String(identityKey).toLowerCase(),
    });
    return !!valid;
  } catch {
    return false;
  }
}
/** Fetch a gist from GitHub and check it proves alias → identityKey. → {ok, sub, login, gist, url} | {ok:false, error}. */
async function checkGist(gist, alias, identityKey, f = fetch) {
  const m = GIST_RE.exec(String(gist || '').trim());
  if (!m) return { ok: false, error: 'Paste the gist link' };
  const r = await f(`https://api.github.com/gists/${m[1]}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'bWalletX' },
  }).catch(() => null);
  if (!r || !r.ok) return { ok: false, error: 'Could not read that gist' };
  const g = await r.json().catch(() => null);
  const login = String(g?.owner?.login || '').toLowerCase();
  if (!login || `${login}.github` !== alias) return { ok: false, error: 'That gist belongs to another GitHub account' };
  for (const file of Object.values(g.files || {})) {
    if (file && !file.truncated && (await verifyGistText(file.content, alias, identityKey)))
      return { ok: true, sub: String(g.owner.id), login, gist: m[1], url: String(g.html_url || '') };
  }
  return { ok: false, error: "The gist does not hold this wallet's signed statement" };
}
/** What we store for a gist proof (in the proofs table's token column). */
const gistEvidence = (g) => JSON.stringify({ gist: g.gist, url: g.url, login: g.login });
/** A stored gist proof as served publicly: enough for any wallet to fetch the gist and check it. */
function gistProofOut(p) {
  let e = {};
  try {
    e = JSON.parse(p.id_token);
  } catch {
    e = {};
  }
  return {
    provider: 'github',
    sub: p.sub,
    identityKey: p.identity_key,
    gist: e.gist,
    url: e.url,
    provenAt: p.created_at,
    statement: gistStatement(p.alias, p.identity_key),
    scheme:
      'public gist by the GitHub login: statement line, then a BRC-43 signature of it ([2,"bwallet paymail"] keyID "1", counterparty anyone)',
  };
}

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
function decode(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    return { header: b64json(parts[0]), claims: b64json(parts[1]), input: `${parts[0]}.${parts[1]}`, sig: parts[2] };
  } catch {
    return null;
  }
}

/** The name a Google token proves: their.name+tag@gmail.com → `theirname.gmail` (verified addresses only). */
function aliasForClaims(provider, claims) {
  if (provider !== 'google' || !claims || claims.email_verified !== true) return null;
  const m = String(claims.email || '')
    .trim()
    .toLowerCase()
    .match(/^([a-z0-9.+_-]+)@(gmail|googlemail)\.com$/);
  if (!m) return null;
  const local = m[1].split('+')[0].replace(/\./g, '');
  return /^[a-z0-9_-]{1,30}$/.test(local) ? `${local.replace(/_/g, '-')}.gmail` : null;
}

/**
 * Check an ID token. keys: [{kid, jwk}]. Returns {ok:true, claims, kid} or {ok:false, error}.
 * `now` (ms) set = also refuse an expired token (the server only stores fresh ones; a stored proof stays valid).
 */
function verifyIdToken(token, { provider, aud, identityKey, keys, now } = {}) {
  const cfg = PROVIDERS[provider];
  if (!cfg) return { ok: false, error: 'Not a provider with signed ID tokens' };
  if (!aud) return { ok: false, error: `${cfg.label} sign-in is not configured` };
  const t = decode(token);
  if (!t) return { ok: false, error: 'Not an ID token' };
  if (t.header.alg !== 'RS256' || !t.header.kid) return { ok: false, error: 'Unsupported token signature' };
  const k = (keys || []).find((x) => x && x.kid === t.header.kid);
  if (!k) return { ok: false, error: 'Unknown signing key' };
  let valid = false;
  try {
    const pub = crypto.createPublicKey({ key: { kty: 'RSA', n: k.jwk.n, e: k.jwk.e }, format: 'jwk' });
    valid = crypto.verify('RSA-SHA256', Buffer.from(t.input), pub, Buffer.from(t.sig, 'base64url'));
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, error: 'Bad token signature' };
  const c = t.claims;
  if (!cfg.iss.includes(c.iss)) return { ok: false, error: 'Wrong issuer' };
  const auds = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!auds.includes(aud)) return { ok: false, error: 'Token was issued to another app' };
  if (!c.sub) return { ok: false, error: 'Token has no account id' };
  if (!identityKey || c.nonce !== proofNonce(identityKey)) return { ok: false, error: 'Token is for another wallet' };
  if (now !== undefined && !(Number(c.exp) * 1000 > now - 5 * 60_000)) return { ok: false, error: 'Token expired' };
  return { ok: true, claims: c, kid: t.header.kid };
}

/** The provider's published keys right now: [{kid, jwk}] (only the public RSA fields). */
async function fetchJwks(provider, f = fetch) {
  const cfg = PROVIDERS[provider];
  if (!cfg) return [];
  const j = await f(cfg.jwks).then((r) => (r.ok ? r.json() : { keys: [] }));
  return (j.keys || [])
    .filter((k) => k && k.kty === 'RSA' && k.kid && k.n && k.e)
    .map((k) => ({
      kid: String(k.kid),
      jwk: { kty: 'RSA', kid: String(k.kid), n: k.n, e: k.e, alg: k.alg || 'RS256' },
    }));
}

/** Name-log alias under which a provider's keys are archived: 'jwks:google'. */
const jwksAlias = (provider) => `jwks:${provider}`;

module.exports = {
  PROVIDERS,
  proofNonce,
  providerForAlias,
  aliasForClaims,
  verifyIdToken,
  decode,
  fetchJwks,
  jwksAlias,
  gistStatement,
  verifyGistText,
  checkGist,
  gistEvidence,
  gistProofOut,
};
