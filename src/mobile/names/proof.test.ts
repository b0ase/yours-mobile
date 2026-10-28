import { beforeAll, describe, expect, test } from 'bun:test';
import { proofNonce, provableProvider, verifyNameProof, type ProviderKey } from './proof';
import { destinationFor, proofRefusal, type Resolved } from './names';

// Locally generated test keys only: no real tokens, client ids or secrets.
const AUD = 'test-client-id.apps.example';
const KEY = '02' + 'ab'.repeat(32);
const OTHER = '03' + 'cd'.repeat(32);
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

type Signer = { kid: string; priv: CryptoKey; pub: ProviderKey };
const makeKey = async (kid: string): Promise<Signer> => {
  const kp = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as { n: string; e: string };
  return { kid, priv: kp.privateKey, pub: { kid, jwk: { kty: 'RSA', kid, n: jwk.n, e: jwk.e, alg: 'RS256' } } };
};
const sign = async (s: Signer, claims: Record<string, unknown>) => {
  const input = `${enc({ alg: 'RS256', kid: s.kid, typ: 'JWT' })}.${enc(claims)}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', s.priv, new TextEncoder().encode(input));
  return `${input}.${Buffer.from(sig).toString('base64url')}`;
};

let k1: Signer;
let k2: Signer;
let claims: Record<string, unknown>;
const iat = 1_761_600_000;
beforeAll(async () => {
  k1 = await makeKey('kid-1');
  k2 = await makeKey('kid-2');
  claims = {
    iss: 'https://accounts.google.com',
    aud: AUD,
    sub: '1234567890',
    email: 'Rich.Ard+bw@gmail.com',
    email_verified: true,
    nonce: await proofNonce(KEY),
    iat,
    exp: iat + 3600,
  };
});
const opts = (o: Partial<Parameters<typeof verifyNameProof>[1]> = {}) => ({
  provider: 'google' as const,
  alias: 'richard.gmail',
  identityKey: KEY,
  aud: AUD,
  live: [k1.pub],
  archived: [] as ProviderKey[],
  ...o,
});

describe('provable names: verifyNameProof', () => {
  test('a good token proves the name for its key', async () => {
    expect(await verifyNameProof(await sign(k1, claims), opts())).toEqual({ ok: true, sub: '1234567890' });
  });
  test('wrong nonce (token binds another wallet) is refused', async () => {
    const t = await sign(k1, claims);
    expect(await verifyNameProof(t, opts({ identityKey: OTHER }))).toEqual({
      ok: false,
      reason: 'proves a different wallet',
    });
    const t2 = await sign(k1, { ...claims, nonce: await proofNonce(OTHER) });
    expect((await verifyNameProof(t2, opts())).ok).toBe(false);
  });
  test('wrong aud (issued to another app) is refused', async () => {
    const t = await sign(k1, { ...claims, aud: 'someone-else' });
    expect(await verifyNameProof(t, opts())).toEqual({ ok: false, reason: 'issued to another app' });
    expect((await verifyNameProof(await sign(k1, claims), opts({ aud: '' }))).ok).toBe(false);
  });
  test('wrong issuer and a different name are refused', async () => {
    expect((await verifyNameProof(await sign(k1, { ...claims, iss: 'https://evil.example' }), opts())).ok).toBe(false);
    expect((await verifyNameProof(await sign(k1, claims), opts({ alias: 'someone.gmail' }))).ok).toBe(false);
    const unverified = await sign(k1, { ...claims, email_verified: false });
    expect((await verifyNameProof(unverified, opts())).ok).toBe(false);
  });
  test('a rotated key verifies from the archive only if logged before the token was issued', async () => {
    const t = await sign(k2, claims);
    // k2 is gone from the provider's published keys.
    expect(await verifyNameProof(t, opts())).toEqual({ ok: false, reason: 'unknown signing key' });
    const early = { ...k2.pub, firstSeen: new Date((iat - 86_400) * 1000).toISOString() };
    expect(await verifyNameProof(t, opts({ archived: [early] }))).toEqual({ ok: true, sub: '1234567890' });
    // A key we "found" long after the token can't vouch for it.
    const late = { ...k2.pub, firstSeen: new Date((iat + 30 * 86_400) * 1000).toISOString() };
    expect((await verifyNameProof(t, opts({ archived: [late] }))).ok).toBe(false);
    // An archive entry under the right kid but the wrong key material fails the signature.
    const swapped = { ...k1.pub, kid: 'kid-2', firstSeen: early.firstSeen };
    expect(await verifyNameProof(t, opts({ archived: [swapped] }))).toEqual({ ok: false, reason: 'bad signature' });
  });
  test('a tampered payload fails the signature', async () => {
    const [h, , s] = (await sign(k1, claims)).split('.');
    const forged = `${h}.${enc({ ...claims, nonce: await proofNonce(OTHER) })}.${s}`;
    expect(await verifyNameProof(forged, opts({ identityKey: OTHER }))).toEqual({ ok: false, reason: 'bad signature' });
    expect((await verifyNameProof('not.a.token', opts())).ok).toBe(false);
    const none = `${enc({ alg: 'none', kid: 'kid-1' })}.${enc(claims)}.`;
    expect((await verifyNameProof(none, opts())).ok).toBe(false);
  });
});

describe('provable names: payment stop', () => {
  const r = (nameProof?: Resolved['nameProof']): Resolved => ({
    input: 'richard.gmail@bwalletx.com',
    target: 'richard.gmail@bwalletx.com',
    targetKind: 'paymail',
    via: 'p2p-paymail',
    pubkey: KEY,
    nameBinding: 'signed',
    nameProof,
  });
  test('only source-tagged names are provable', () => {
    expect(provableProvider('richard.gmail')).toBe('google');
    expect(provableProvider('richard')).toBeNull();
    expect(provableProvider('b0ase.x')).toBeNull();
  });
  test('proven pays; missing, bad, sub-changed and unchecked stop', () => {
    expect(destinationFor(r({ status: 'proven', provider: 'google', sub: '1' }), 'bsv').ok).toBe(true);
    expect(destinationFor(r(), 'bsv').ok).toBe(true); // not provable: unaffected
    for (const status of ['missing', 'bad', 'sub-changed', 'unchecked'] as const) {
      const d = destinationFor(r({ status, provider: 'google' }), 'bsv');
      expect(d.ok).toBe(false);
      expect(proofRefusal(r({ status, provider: 'google' }))).toContain('Not paying it');
    }
  });
});
