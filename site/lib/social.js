// bWalletX "Continue with X / Google" (Create Account), run by bWalletX itself (owner, 4 Oct 2026).
//
//   start    POST {provider, verifier_hash}  → {authorizeUrl}. The app keeps a random secret and sends
//            only its sha256. The OAuth state is sealed here (AES-256-GCM, SOCIAL_SEAL_KEY) and
//            carries that hash, the PKCE verifier (X) and an expiry.
//   callback the provider returns here; we read the account and seal a TICKET bound to the hash,
//            then send the browser to www.bwallet.space/social#t=… (the app opens; the fragment is
//            never sent to a server).
//   preview  POST {ticket, secret} → {provider, name, display, avatar, alias}.
//   register (paymail.js) accepts `<name>.x` / `<name>.gmail` only with a ticket + secret that
//            prove that name. Aliases are unique, so one X name / Gmail address = one wallet.
//
// The ticket alone is worthless: it only opens with the secret, which never left the app.
// Env: SOCIAL_SEAL_KEY (32-byte hex), X_CLIENT_ID / X_CLIENT_SECRET, GOOGLE_CLIENT_ID /
//      GOOGLE_CLIENT_SECRET, GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET, LINKEDIN_CLIENT_ID /
//      LINKEDIN_CLIENT_SECRET, SOCIAL_BASE_URL (optional, default https://pay.bwallet.space).
//
// Provable names (owner, 28 Oct 2026; bitcoin-corp docs/PROVABLE-NAMES.md): start with proof_key (the wallet's
// identity key) and Google / LinkedIn put proofNonce(proof_key) in the ID token's nonce. The ticket then carries that
// raw ID token (`it`) so the paymail server can store it as the name's proof (paymail.js 'prove').
//
// "Link your accounts" (owner, 18 Oct 2026): the same tickets prove an X / Google / GitHub / LinkedIn account
// for a link the wallet signs with its identity key. A provider without its env pair answers 503 and
// `providers` reports it off, so the app shows that row as coming soon instead of a broken button.
'use strict';
const crypto = require('crypto');
const { proofNonce } = require('./nameProof');
const PUBKEY_RE = /^0[23][0-9a-f]{64}$/;

const TTL_MS = 10 * 60_000;
const RETURN = 'https://www.bwallet.space/social';
const base = (env) => String(env.SOCIAL_BASE_URL || 'https://pay.bwallet.space').replace(/\/$/, '');
const redirectUri = (provider, env) => `${base(env)}/api/social/${provider}/callback`;

function key(env) {
  const k = String(env.SOCIAL_SEAL_KEY || '');
  if (!/^[0-9a-f]{64}$/i.test(k)) throw new Error('SOCIAL_SEAL_KEY is not configured');
  return Buffer.from(k, 'hex');
}
function seal(obj, env) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(env), iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}
function open(raw, env) {
  try {
    const b = Buffer.from(String(raw || ''), 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', key(env), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
  } catch {
    return null;
  }
}
const sha256Hex = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

/**
 * The one social name a sign-in proves: X @B0aseX → `b0asex.x`; their.name+t@gmail.com → `theirname.gmail`;
 * GitHub login Octo-Cat → `octo-cat.github`. LinkedIn has no public @name in OpenID Connect, so it proves no name by
 * itself (null here): see linkedinSlug. Anything else null.
 */
function socialAliasFor(provider, name) {
  const n = String(name || '')
    .trim()
    .toLowerCase();
  if (provider === 'x') return /^[a-z0-9_]{1,15}$/.test(n) ? `${n.replace(/_/g, '-')}.x` : null;
  // GitHub logins: a-z, 0-9 and single hyphens, not at the ends, up to 39 chars. Our names stop at 30 + suffix.
  if (provider === 'github') return /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/.test(n) ? `${n}.github` : null;
  if (provider !== 'google') return null;
  const m = n.match(/^([a-z0-9.+_-]+)@(gmail|googlemail)\.com$/);
  if (!m) return null;
  const local = m[1].split('+')[0].replace(/\./g, '');
  return /^[a-z0-9_-]{1,30}$/.test(local) ? `${local.replace(/_/g, '-')}.gmail` : null;
}

/**
 * LinkedIn's suggested name base (owner, 28 Oct 2026). LinkedIn's OpenID Connect profile gives `sub` (stable, unique,
 * opaque: not user-visible), name / given_name / family_name and picture, but NOT the vanity URL slug
 * (linkedin.com/in/<slug>): that needs a partner-only API. So the user picks the slug, prefilled from their name
 * ("Richard Boase" → `richardboase`), and the name is bound to the LinkedIn account (`sub`) on first claim: one
 * `.linkedin` name per LinkedIn account, and only that account's signed ID token can prove it later.
 */
function linkedinSlug(display) {
  const s = String(display || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 30);
  return s || null;
}

/** What a ticket proves, if the secret matches and it hasn't expired. */
function openTicket(ticket, secret, env = process.env, now = Date.now()) {
  const t = open(ticket, env);
  if (!t || !(t.e > now) || !t.name || !/^[0-9a-f]{64}$/.test(String(t.vh || ''))) return null;
  const a = Buffer.from(t.vh, 'hex');
  const b = Buffer.from(sha256Hex(secret || ''), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return {
    provider: t.p,
    id: t.id,
    name: t.name,
    display: t.d || null,
    avatar: t.a || null,
    // Deprecated (owner, 9 Oct 2026: users choose their handle). Kept for app builds that still
    // register `<name>.x`; never a Gmail-derived name now, since that published the address.
    alias: t.p === 'x' ? socialAliasFor(t.p, t.name) : null,
    // New clients: open "Choose your handle" prefilled with suggested_handle (the X @name only).
    choose_handle: true,
    // The social name this sign-in can claim (`name.x` / `name.gmail` / `name.github`), or for LinkedIn a suggested
    // `slug.linkedin` the user may edit (it is bound to this LinkedIn account when claimed).
    social_alias:
      t.p === 'linkedin' ? (linkedinSlug(t.d) ? `${linkedinSlug(t.d)}.linkedin` : null) : socialAliasFor(t.p, t.name),
    suggested_handle: suggestedHandleFor(t.p, t.name),
    // Provable names (docs/PROVABLE-NAMES.md): the provider-signed ID token whose nonce binds proof_key. Only when
    // the sign-in was started with a proof_key; never an access or refresh token.
    ...(t.it ? { id_token: t.it, proof_key: t.pk } : {}),
  };
}

/** The handle to prefill: the X @name as a plain alias (`B0ase_X` → `b0ase-x`); never anything from an email. */
function suggestedHandleFor(provider, name) {
  if (provider !== 'x') return null;
  const n = String(name || '')
    .trim()
    .toLowerCase();
  return /^[a-z0-9_]{1,15}$/.test(n) ? n.replace(/_/g, '-').replace(/^-+|-+$/g, '') || null : null;
}

// Where the browser lands after the provider. A fixed list, never a caller-supplied URL (no open redirect).
// 'web': the web wallet, in the same tab it started from (owner, 6 Oct 2026: the return page stranded web
// users on "you're signed in" with no way back to the wallet tab).
// 'testers': the paid Android testers sign-up page (bwalletx.com/testers); the ticket is verified there
// server-side via /api/social/preview.
const RETURNS = {
  app: RETURN,
  web: 'https://web.bwalletx.com/',
  beta: 'https://beta.bwalletx.com/',
  desktop: 'https://desktop.bwalletx.com/',
  testers: 'https://bwalletx.com/testers',
};
const returnUrl = (q, to = 'app') => `${RETURNS[to] || RETURN}#${new URLSearchParams(q).toString()}`;

const PROVIDERS = ['x', 'google', 'github', 'linkedin'];
const ENV_PAIR = {
  x: ['X_CLIENT_ID', 'X_CLIENT_SECRET'],
  google: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  github: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
  linkedin: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
};
const configured = (provider, env) => !!ENV_PAIR[provider] && ENV_PAIR[provider].every((k) => !!env[k]);
/** Which providers can link right now (no secrets, just on/off). */
const providers = (env = process.env) => Object.fromEntries(PROVIDERS.map((p) => [p, configured(p, env)]));

function start({ provider, verifier_hash: vh, return_to, proof_key }, env = process.env, now = Date.now()) {
  const r = Object.hasOwn(RETURNS, return_to) && return_to !== 'app' ? return_to : undefined;
  // Provable names: Google / LinkedIn sign the wallet's key into the ID token's nonce (OpenID Connect).
  const pk = PUBKEY_RE.test(String(proof_key || '').toLowerCase()) ? String(proof_key).toLowerCase() : undefined;
  if (proof_key !== undefined && !pk) return [400, { error: 'proof_key must be a compressed public key' }];
  if (!PROVIDERS.includes(provider)) return [400, { error: 'provider must be x, google, github or linkedin' }];
  if (!/^[0-9a-f]{64}$/.test(String(vh || ''))) return [400, { error: 'verifier_hash must be sha256 hex' }];
  const e = now + TTL_MS;
  if (provider === 'x') {
    if (!env.X_CLIENT_ID || !env.X_CLIENT_SECRET) return [503, { error: 'X sign-in is not configured yet' }];
    const v = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(v).digest('base64url');
    const u = new URL('https://x.com/i/oauth2/authorize');
    u.search = new URLSearchParams({
      response_type: 'code',
      client_id: env.X_CLIENT_ID,
      redirect_uri: redirectUri('x', env),
      scope: 'users.read tweet.read',
      state: seal({ p: 'x', vh, v, e, r }, env),
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    return [200, { authorizeUrl: u.toString() }];
  }
  if (provider === 'github') {
    if (!configured('github', env)) return [503, { error: 'GitHub linking is not configured yet' }];
    const u = new URL('https://github.com/login/oauth/authorize');
    u.search = new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      redirect_uri: redirectUri('github', env),
      scope: 'read:user',
      state: seal({ p: 'github', vh, e, r }, env),
      allow_signup: 'false',
    }).toString();
    return [200, { authorizeUrl: u.toString() }];
  }
  if (provider === 'linkedin') {
    if (!configured('linkedin', env)) return [503, { error: 'LinkedIn linking is not configured yet' }];
    const u = new URL('https://www.linkedin.com/oauth/v2/authorization');
    u.search = new URLSearchParams({
      response_type: 'code',
      client_id: env.LINKEDIN_CLIENT_ID,
      redirect_uri: redirectUri('linkedin', env),
      scope: 'openid profile',
      state: seal({ p: 'linkedin', vh, e, r, pk }, env),
      ...(pk ? { nonce: proofNonce(pk) } : {}),
    }).toString();
    return [200, { authorizeUrl: u.toString() }];
  }
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)
    return [503, { error: 'Google sign-in is not configured yet' }];
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri('google', env),
    response_type: 'code',
    scope: 'openid email profile',
    state: seal({ p: 'google', vh, e, r, pk }, env),
    access_type: 'online',
    prompt: 'select_account',
    ...(pk ? { nonce: proofNonce(pk) } : {}),
  }).toString();
  return [200, { authorizeUrl: u.toString() }];
}

/** Provider callback → the redirect URL for the browser (always to the return page). */
async function callback(provider, q, env = process.env, f = fetch, now = Date.now()) {
  const st = open(q.state, env);
  if (!st || st.p !== provider || !(st.e > now))
    return returnUrl({ error: 'That sign-in has expired. Please try again.' });
  const to = st.r && Object.hasOwn(RETURNS, st.r) ? st.r : 'app';
  if (q.error || !q.code)
    return returnUrl({ error: q.error === 'access_denied' ? 'cancelled' : q.error || 'cancelled' }, to);
  try {
    let user;
    // The provider-signed ID token, kept only when the sign-in asked for a proof (st.pk). Access tokens are used for
    // the one profile read below and dropped.
    let idToken;
    if (provider === 'x') {
      const tok = await f('https://api.x.com/2/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + Buffer.from(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`).toString('base64'),
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: q.code,
          redirect_uri: redirectUri('x', env),
          code_verifier: st.v,
        }),
      }).then((r) => r.json());
      if (!tok.access_token) throw new Error(tok.error_description || tok.error || 'X token exchange failed');
      const me = await f('https://api.x.com/2/users/me?user.fields=profile_image_url', {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      }).then((r) => r.json());
      if (!me.data?.id) throw new Error('Could not read the X account');
      user = {
        id: me.data.id,
        name: me.data.username,
        d: me.data.name,
        a: me.data.profile_image_url?.replace('_normal.', '_400x400.'),
      };
    } else if (provider === 'github') {
      const tok = await f('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code: q.code,
          redirect_uri: redirectUri('github', env),
        }),
      }).then((r) => r.json());
      if (!tok.access_token) throw new Error(tok.error_description || 'GitHub token exchange failed');
      const me = await f('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json', 'User-Agent': 'bWalletX' },
      }).then((r) => r.json());
      if (!me.id || !me.login) throw new Error('Could not read the GitHub account');
      user = { id: String(me.id), name: me.login, d: me.name || me.login, a: me.avatar_url };
    } else if (provider === 'linkedin') {
      const tok = await f('https://www.linkedin.com/oauth/v2/accessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: q.code,
          redirect_uri: redirectUri('linkedin', env),
          client_id: env.LINKEDIN_CLIENT_ID,
          client_secret: env.LINKEDIN_CLIENT_SECRET,
        }),
      }).then((r) => r.json());
      if (!tok.access_token) throw new Error(tok.error_description || 'LinkedIn token exchange failed');
      const me = await f('https://api.linkedin.com/v2/userinfo', {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      }).then((r) => r.json());
      if (!me.sub) throw new Error('Could not read the LinkedIn account');
      if (st.pk && typeof tok.id_token === 'string') idToken = tok.id_token;
      // LinkedIn has no public @name: the opaque member id stands in, and only the display name is shown.
      user = { id: String(me.sub), name: String(me.sub), d: me.name, a: me.picture };
    } else {
      const tok = await f('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: q.code,
          redirect_uri: redirectUri('google', env),
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
        }),
      }).then((r) => r.json());
      if (!tok.access_token) throw new Error(tok.error_description || 'Google token exchange failed');
      const u = await f('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      }).then((r) => r.json());
      // Google's own word that the address is theirs; an unverified email proves nothing.
      if (!u.id || !u.email || u.verified_email !== true) throw new Error('Google did not confirm that email address');
      user = { id: String(u.id), name: u.email, d: u.name, a: u.picture };
      if (st.pk && typeof tok.id_token === 'string') idToken = tok.id_token;
    }
    const ticket = seal(
      {
        p: provider,
        id: user.id,
        name: String(user.name).trim().toLowerCase(),
        d: user.d,
        a: user.a,
        vh: st.vh,
        e: now + TTL_MS,
        ...(idToken ? { it: idToken, pk: st.pk } : {}),
      },
      env,
    );
    return returnUrl({ p: provider, name: user.name, t: ticket }, to);
  } catch (e) {
    return returnUrl({ error: e instanceof Error ? e.message : 'Sign-in failed' }, to);
  }
}

module.exports = {
  start,
  providers,
  PROVIDERS,
  callback,
  openTicket,
  socialAliasFor,
  linkedinSlug,
  suggestedHandleFor,
  seal,
  open,
  sha256Hex,
  TTL_MS,
};
