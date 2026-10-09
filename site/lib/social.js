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
//      GOOGLE_CLIENT_SECRET, SOCIAL_BASE_URL (optional, default https://pay.bwallet.space).
'use strict';
const crypto = require('crypto');

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

/** X @B0aseX → `b0asex.x`; their.name+t@gmail.com → `theirname.gmail`; anything else null. */
function socialAliasFor(provider, name) {
  const n = String(name || '')
    .trim()
    .toLowerCase();
  if (provider === 'x') return /^[a-z0-9_]{1,15}$/.test(n) ? `${n.replace(/_/g, '-')}.x` : null;
  const m = n.match(/^([a-z0-9.+_-]+)@(gmail|googlemail)\.com$/);
  if (!m) return null;
  const local = m[1].split('+')[0].replace(/\./g, '');
  return /^[a-z0-9_-]{1,30}$/.test(local) ? `${local.replace(/_/g, '-')}.gmail` : null;
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
    alias: socialAliasFor(t.p, t.name),
  };
}

// Where the browser lands after the provider. A fixed list, never a caller-supplied URL (no open redirect).
// 'web': the web wallet, in the same tab it started from (owner, 6 Oct 2026: the return page stranded web
// users on "you're signed in" with no way back to the wallet tab).
// 'testers': the paid Android testers sign-up page (bwalletx.com/testers); the ticket is verified there
// server-side via /api/social/preview.
const RETURNS = { app: RETURN, web: 'https://web.bwalletx.com/', beta: 'https://beta.bwalletx.com/', desktop: 'https://desktop.bwalletx.com/', testers: 'https://bwalletx.com/testers' };
const returnUrl = (q, to = 'app') => `${RETURNS[to] || RETURN}#${new URLSearchParams(q).toString()}`;

function start({ provider, verifier_hash: vh, return_to }, env = process.env, now = Date.now()) {
  const r = Object.hasOwn(RETURNS, return_to) && return_to !== 'app' ? return_to : undefined;
  if (provider !== 'x' && provider !== 'google') return [400, { error: 'provider must be x or google' }];
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
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)
    return [503, { error: 'Google sign-in is not configured yet' }];
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri('google', env),
    response_type: 'code',
    scope: 'openid email profile',
    state: seal({ p: 'google', vh, e, r }, env),
    access_type: 'online',
    prompt: 'select_account',
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
      },
      env,
    );
    return returnUrl({ p: provider, name: user.name, t: ticket }, to);
  } catch (e) {
    return returnUrl({ error: e instanceof Error ? e.message : 'Sign-in failed' }, to);
  }
}

module.exports = { start, callback, openTicket, socialAliasFor, seal, open, sha256Hex, TTL_MS };
