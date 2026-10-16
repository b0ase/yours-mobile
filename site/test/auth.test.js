import { describe, expect, test } from 'bun:test';
import crypto from 'crypto';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import auth from '../lib/auth.js';

const { makeAuth, memoryAuthStore, pkceOk, authMessage, signedFields, SIGN_PROTOCOL, SIGN_KEY_ID } = auth;

// A throwaway ES256 key made per test run. Never a real key.
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const ENV = {
  BWALLETX_AUTH_SIGNING_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  BWALLETX_AUTH_ISSUER: 'https://auth.test',
};
const CLIENTS = { app: { name: 'Test App', site: 'app.test', redirectUris: ['https://app.test/cb'] } };

const verifier = 'v'.repeat(20) + crypto.randomBytes(24).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

const userKey = PrivateKey.fromRandom();
const wallet = new ProtoWallet(userKey);

const setup = (over = {}) => {
  let t = 1_800_000_000_000;
  const store = memoryAuthStore();
  const a = makeAuth({
    store,
    env: ENV,
    clients: CLIENTS,
    now: () => t,
    lookupAlias: async () => ({ alias: 'alice', domain: 'bwalletx.com' }),
    level: async () => 3,
    ...over,
  });
  return { a, store, tick: (ms) => (t += ms), now: () => t };
};

const authorizeQ = (over = {}) => ({
  response_type: 'code',
  client_id: 'app',
  redirect_uri: 'https://app.test/cb',
  scope: 'openid profile bitsign',
  state: 'st8',
  nonce: 'n0nce',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  ...over,
});

const sign = async (row, action, now, w = wallet) => {
  const { publicKey: identityKey } = await w.getPublicKey({ identityKey: true });
  const { signature } = await w.createSignature({
    data: Utils.toArray(authMessage(action, signedFields(row, identityKey, now)), 'utf8'),
    protocolID: SIGN_PROTOCOL,
    keyID: SIGN_KEY_ID,
    counterparty: 'anyone',
  });
  return { id: row.id, identityKey, timestamp: now, signature: Utils.toHex(signature) };
};

/** Run /authorize → approve → status; returns the code, the cookie and the row. */
const signIn = async (ctx) => {
  const r = await ctx.a.authorize(authorizeQ());
  expect(r.status).toBe(200);
  const cookie = r.headers['Set-Cookie'].split(';')[0];
  const id = cookie.split('=')[1].split('.')[0];
  const row = await ctx.store.get(id);
  const ap = await ctx.a.approve(await sign(row, 'approve', ctx.now()));
  expect(ap.status).toBe(200);
  const st = await ctx.a.status({ id }, cookie);
  expect(st.json.status).toBe('approved');
  const u = new URL(st.json.redirect);
  expect(u.searchParams.get('state')).toBe('st8');
  return { code: u.searchParams.get('code'), cookie, id };
};

const tokenBody = (code, over = {}) => ({
  grant_type: 'authorization_code',
  code,
  redirect_uri: 'https://app.test/cb',
  client_id: 'app',
  code_verifier: verifier,
  ...over,
});

describe('PKCE', () => {
  test('S256 verifier matches its challenge', () => {
    expect(pkceOk(verifier, challenge)).toBe(true);
  });
  test('wrong or malformed verifier fails', () => {
    expect(pkceOk(verifier + 'x', challenge)).toBe(false);
    expect(pkceOk('short', challenge)).toBe(false);
    expect(pkceOk(verifier, 'not-a-challenge')).toBe(false);
  });
  test('authorize refuses plain or missing PKCE (redirects with error)', async () => {
    const { a } = setup();
    const r = await a.authorize(authorizeQ({ code_challenge_method: 'plain' }));
    expect(r.status).toBe(302);
    expect(new URL(r.redirect).searchParams.get('error')).toBe('invalid_request');
    const r2 = await a.authorize(authorizeQ({ code_challenge: '' }));
    expect(r2.status).toBe(302);
  });
  test('token with the wrong verifier is refused', async () => {
    const ctx = setup();
    const { code } = await signIn(ctx);
    const t = await ctx.a.token(tokenBody(code, { code_verifier: 'w'.repeat(43) }));
    expect(t.status).toBe(400);
    expect(t.json.error).toBe('invalid_grant');
  });
});

describe('client allowlist', () => {
  test('unknown client and unregistered redirect are shown, never redirected', async () => {
    const { a } = setup();
    expect((await a.authorize(authorizeQ({ client_id: 'evil' }))).status).toBe(400);
    const r = await a.authorize(authorizeQ({ redirect_uri: 'https://evil.test/cb' }));
    expect(r.status).toBe(400);
    expect(r.redirect).toBeUndefined();
  });
  test('no signing key: sign-in is unavailable', async () => {
    const { a } = setup({ env: { BWALLETX_AUTH_ISSUER: 'https://auth.test' }, key: null });
    const r = await a.authorize(authorizeQ());
    expect(new URL(r.redirect).searchParams.get('error')).toBe('temporarily_unavailable');
  });
});

describe('signature verify', () => {
  test('a good identity-key signature approves', async () => {
    const ctx = setup();
    const { code } = await signIn(ctx);
    expect(code).toBeTruthy();
  });
  test('a signature by another key, a tampered field or an old timestamp is refused', async () => {
    const ctx = setup();
    const r = await ctx.a.authorize(authorizeQ());
    const id = r.headers['Set-Cookie'].split('=')[1].split('.')[0];
    const row = await ctx.store.get(id);
    const good = await sign(row, 'approve', ctx.now());
    // Signed by someone else but claiming this identity key.
    const other = await sign(row, 'approve', ctx.now(), new ProtoWallet(PrivateKey.fromRandom()));
    expect((await ctx.a.approve({ ...other, identityKey: good.identityKey })).status).toBe(401);
    // Signed for another redirect URI.
    const forged = await sign({ ...row, redirect_uri: 'https://evil.test/cb' }, 'approve', ctx.now());
    expect((await ctx.a.approve(forged)).status).toBe(401);
    // A deny signature can't approve.
    expect((await ctx.a.approve(await sign(row, 'deny', ctx.now()))).status).toBe(401);
    // Ten minutes late.
    ctx.tick(6 * 60_000);
    expect((await ctx.a.approve(good)).json.error).toMatch(/expired/);
    expect((await ctx.store.get(id)).status).toBe('pending');
  });
  test('deny sends the browser back with access_denied', async () => {
    const ctx = setup();
    const r = await ctx.a.authorize(authorizeQ());
    const cookie = r.headers['Set-Cookie'].split(';')[0];
    const id = cookie.split('=')[1].split('.')[0];
    const row = await ctx.store.get(id);
    expect((await ctx.a.deny(await sign(row, 'deny', ctx.now()))).status).toBe(200);
    const st = await ctx.a.status({ id }, cookie);
    expect(new URL(st.json.redirect).searchParams.get('error')).toBe('access_denied');
  });
});

describe('code handling', () => {
  test('a code works once, then is refused', async () => {
    const ctx = setup();
    const { code } = await signIn(ctx);
    const t1 = await ctx.a.token(tokenBody(code));
    expect(t1.status).toBe(200);
    const t2 = await ctx.a.token(tokenBody(code));
    expect(t2.status).toBe(400);
    expect(t2.json.error).toBe('invalid_grant');
  });
  test('a failed attempt (wrong verifier) still burns the code', async () => {
    const ctx = setup();
    const { code } = await signIn(ctx);
    await ctx.a.token(tokenBody(code, { code_verifier: 'w'.repeat(43) }));
    expect((await ctx.a.token(tokenBody(code))).status).toBe(400);
  });
  test('the code is handed to the browser once and only its hash is stored', async () => {
    const ctx = setup();
    const { code, cookie, id } = await signIn(ctx);
    const row = await ctx.store.get(id);
    expect(JSON.stringify(row)).not.toContain(code);
    expect((await ctx.a.status({ id }, cookie)).json.redirect).toBeUndefined();
  });
  test('status needs the cookie of the browser that started', async () => {
    const ctx = setup();
    const r = await ctx.a.authorize(authorizeQ());
    const id = r.headers['Set-Cookie'].split('=')[1].split('.')[0];
    expect((await ctx.a.status({ id }, `bwx_auth=${id}.${'0'.repeat(48)}`)).status).toBe(403);
    expect((await ctx.a.status({ id }, '')).status).toBe(403);
  });
  test('an old code is refused', async () => {
    const ctx = setup();
    const { code } = await signIn(ctx);
    ctx.tick(3 * 60_000);
    expect((await ctx.a.token(tokenBody(code))).status).toBe(400);
  });
  test('redirect_uri and client_id must match', async () => {
    const ctx = setup();
    const { code } = await signIn(ctx);
    expect((await ctx.a.token(tokenBody(code, { client_id: 'other' }))).status).toBe(400);
  });
});

describe('tokens and claims', () => {
  test('id_token verifies against JWKS and carries the claims', async () => {
    const ctx = setup();
    const { code } = await signIn(ctx);
    const t = await ctx.a.token(tokenBody(code));
    const [h, p, s] = t.json.id_token.split('.');
    const { keys } = (await ctx.a.jwks()).json;
    const pub = crypto.createPublicKey({ key: keys[0], format: 'jwk' });
    const ok = crypto.verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      { key: pub, dsaEncoding: 'ieee-p1363' },
      Buffer.from(s, 'base64url'),
    );
    expect(ok).toBe(true);
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    const idKey = userKey.toPublicKey().toString();
    expect(claims).toMatchObject({
      iss: 'https://auth.test',
      aud: 'app',
      sub: idKey,
      identity_key: idKey,
      paymail: 'alice@bwalletx.com',
      handle: '$alice',
      bitsign_level: 3,
      nonce: 'n0nce',
    });
    expect(claims.exp - claims.iat).toBe(600);
  });
  test('userinfo answers a valid access token and refuses an id_token or garbage', async () => {
    const ctx = setup();
    const { code } = await signIn(ctx);
    const t = await ctx.a.token(tokenBody(code));
    const u = await ctx.a.userinfo(`Bearer ${t.json.access_token}`);
    expect(u.status).toBe(200);
    expect(u.json.handle).toBe('$alice');
    expect((await ctx.a.userinfo(`Bearer ${t.json.id_token}`)).status).toBe(401);
    expect((await ctx.a.userinfo('Bearer x.y.z')).status).toBe(401);
    ctx.tick(11 * 60_000);
    expect((await ctx.a.userinfo(`Bearer ${t.json.access_token}`)).status).toBe(401);
  });
  test('discovery names the endpoints', async () => {
    const { a } = setup();
    const d = (await a.discovery()).json;
    expect(d.authorization_endpoint).toBe('https://auth.test/authorize');
    expect(d.code_challenge_methods_supported).toEqual(['S256']);
  });
  test('the wallet sheet sees the app and scopes, never the state or challenge', async () => {
    const ctx = setup();
    const r = await ctx.a.authorize(authorizeQ());
    const id = r.headers['Set-Cookie'].split('=')[1].split('.')[0];
    const q = await ctx.a.request({ id });
    expect(q.json.client.name).toBe('Test App');
    expect(JSON.stringify(q.json)).not.toContain('st8');
    expect(JSON.stringify(q.json)).not.toContain(challenge);
  });
});
