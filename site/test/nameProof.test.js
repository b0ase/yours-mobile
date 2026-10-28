import { describe, expect, test } from 'bun:test';
import crypto from 'crypto';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import pm from '../lib/paymail.js';
import social from '../lib/social.js';
import np from '../lib/nameProof.js';

// Locally generated test keys and a throwaway seal key only: no real tokens, client ids or secrets.
const AUD = 'test-client-id.apps.example';
const ENV = { PAYMAIL_DOMAIN: 'pay.test', SOCIAL_SEAL_KEY: 'ab'.repeat(32), GOOGLE_CLIENT_ID: AUD };

const rsa = (kid) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const j = publicKey.export({ format: 'jwk' });
  return { kid, privateKey, pub: { kid, jwk: { kty: 'RSA', kid, n: j.n, e: j.e, alg: 'RS256' } } };
};
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (k, claims) => {
  const input = `${enc({ alg: 'RS256', kid: k.kid })}.${enc(claims)}`;
  return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), k.privateKey).toString('base64url')}`;
};

const user = () => {
  const priv = PrivateKey.fromRandom();
  const wallet = new ProtoWallet(priv);
  const identityKey = priv.toPublicKey().toString();
  const sign = async (action, fields, timestamp = Date.now()) => {
    const all = { ...fields, nonce: crypto.randomBytes(16).toString('hex'), identityKey, timestamp: String(timestamp) };
    const { signature } = await wallet.createSignature({
      data: Utils.toArray(pm.signedMessage(action, all), 'utf8'),
      protocolID: pm.SIGN_PROTOCOL,
      keyID: pm.SIGN_KEY_ID,
      counterparty: 'anyone',
    });
    const { identityKey: _k, timestamp: _t, ...f } = all;
    return { identityKey, timestamp, fields: f, signature: Utils.toHex(signature) };
  };
  return { identityKey, sign };
};

const store = (rows) => {
  const aliases = new Map(rows.map((r) => [r.alias, r]));
  const proofs = new Map();
  const log = [];
  return {
    log,
    proofs,
    getAlias: async (a) => aliases.get(a) ?? null,
    getForward: async () => null,
    getBinding: async () => null,
    getProof: async (a) => proofs.get(a) ?? null,
    putProof: async (p) => void proofs.set(p.alias, { ...p }),
    logName: async (r) => void log.push({ ...r, created_at: new Date().toISOString() }),
    providerKeys: async (alias) => log.filter((r) => r.alias === alias && r.action === 'jwks'),
  };
};

const now = Date.now();
const claimsFor = (identityKey, extra = {}) => ({
  iss: 'https://accounts.google.com',
  aud: AUD,
  sub: 'g-123',
  email: 'rich.ard@gmail.com',
  email_verified: true,
  nonce: np.proofNonce(identityKey),
  iat: Math.floor(now / 1000),
  exp: Math.floor(now / 1000) + 3600,
  ...extra,
});
const ticketFor = (idToken, secret = 's3cret') =>
  social.seal(
    {
      p: 'google',
      id: 'g-123',
      name: 'rich.ard@gmail.com',
      vh: social.sha256Hex(secret),
      e: now + 60_000,
      it: idToken,
    },
    ENV,
  );

describe('nameProof.verifyIdToken', () => {
  const k = rsa('k1');
  const key = '02' + 'ab'.repeat(32);
  const o = { provider: 'google', aud: AUD, identityKey: key, keys: [k.pub] };
  test('good token; wrong nonce, aud, key and tampered payload are refused', () => {
    expect(np.verifyIdToken(jwt(k, claimsFor(key)), o).ok).toBe(true);
    expect(np.verifyIdToken(jwt(k, claimsFor(key)), { ...o, identityKey: '03' + 'cd'.repeat(32) }).ok).toBe(false);
    expect(np.verifyIdToken(jwt(k, claimsFor(key, { aud: 'other' })), o).ok).toBe(false);
    expect(np.verifyIdToken(jwt(k, claimsFor(key)), { ...o, keys: [rsa('k1').pub] }).ok).toBe(false);
    const [h, , s] = jwt(k, claimsFor(key)).split('.');
    expect(np.verifyIdToken(`${h}.${enc(claimsFor(key, { sub: 'evil' }))}.${s}`, o).ok).toBe(false);
  });
  test('the email gives the name', () => {
    expect(np.aliasForClaims('google', claimsFor(key))).toBe('richard.gmail');
    expect(np.aliasForClaims('google', claimsFor(key, { email_verified: false }))).toBeNull();
  });
});

describe('social start asks for the nonce', () => {
  test('proof_key puts proofNonce in the Google authorize URL', () => {
    const env = { ...ENV, GOOGLE_CLIENT_SECRET: 'x' };
    const key = '02' + 'ab'.repeat(32);
    const [st, out] = social.start({ provider: 'google', verifier_hash: 'a'.repeat(64), proof_key: key }, env);
    expect(st).toBe(200);
    expect(new URL(out.authorizeUrl).searchParams.get('nonce')).toBe(np.proofNonce(key));
    expect(social.start({ provider: 'google', verifier_hash: 'a'.repeat(64), proof_key: 'nope' }, env)[0]).toBe(400);
  });
});

describe('prove: storing a name proof', () => {
  const setup = () => {
    const owner = user();
    const k = rsa('k1');
    const s = store([{ alias: 'richard.gmail', identity_key: owner.identityKey, kind: 'gmail' }]);
    const h = pm.makeHandlers({ store: s, env: ENV, now: () => now, providerJwks: async () => [k.pub] });
    return { owner, k, s, h };
  };
  test('stores the token, archives the key, serves it on pki and name-proof', async () => {
    const { owner, k, s, h } = setup();
    const body = {
      ...(await owner.sign('prove', { alias: 'richard.gmail' })),
      ticket: ticketFor(jwt(k, claimsFor(owner.identityKey))),
      secret: 's3cret',
    };
    const [st, out] = await h.prove({}, body);
    expect(st).toBe(200);
    expect(out.proof.sub).toBe('g-123');
    expect(s.log.map((r) => r.action)).toEqual(['jwks', 'prove']);
    const [, pki] = await h.pki({ handle: 'richard.gmail@pay.test' });
    expect(pki.proof.idToken).toBe(s.proofs.get('richard.gmail').id_token);
    expect(pki.proof.keys.map((x) => x.kid)).toEqual(['k1']);
    const [, keys] = await h['provider-keys']({ provider: 'google' });
    expect(keys.keys[0].kid).toBe('k1');
    const [gs] = await h['name-proof']({ handle: 'richard.gmail@pay.test' });
    expect(gs).toBe(200);
  });
  test('refuses another wallet, a different account (sub) and a plain name', async () => {
    const { owner, k, h } = setup();
    const other = user();
    const bad = {
      ...(await other.sign('prove', { alias: 'richard.gmail' })),
      ticket: ticketFor(jwt(k, claimsFor(other.identityKey))),
      secret: 's3cret',
    };
    expect((await h.prove({}, bad))[0]).toBe(403);
    const ok = {
      ...(await owner.sign('prove', { alias: 'richard.gmail' })),
      ticket: ticketFor(jwt(k, claimsFor(owner.identityKey))),
      secret: 's3cret',
    };
    expect((await h.prove({}, ok))[0]).toBe(200);
    const swap = {
      ...(await owner.sign('prove', { alias: 'richard.gmail' })),
      ticket: ticketFor(jwt(k, claimsFor(owner.identityKey, { sub: 'g-999' }))),
      secret: 's3cret',
    };
    expect((await h.prove({}, swap))[0]).toBe(409);
    const plain = { ...(await owner.sign('prove', { alias: 'richard' })), ticket: ticketFor('x'), secret: 's3cret' };
    expect((await h.prove({}, plain))[0]).toBe(400);
  });
});
