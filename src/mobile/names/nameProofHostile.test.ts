import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet } from '@bsv/sdk';
import { keyChange, trustCurrentKey } from './binding';
import { KEY_CHANGED, destinationFor, parseRecipient, resolveRecipient, trustResolvedKey, type Fetch } from './names';
import { signRequest } from './paymail';
import { proofNonce, resetProviderKeyCache, trustProofSub, verifyNameProof, type ProviderKey } from './proof';

/**
 * b-Aware backlog rank 4 (rows 357, 391, 136; Makino 650, Ahmad Said 695, mahetagaurang22): a hostile paymail
 * server. Locally generated test keys only: no real tokens, client ids or secrets.
 */
const AUD = 'test-client-id.apps.example';
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
const signJwt = async (s: Signer, claims: Record<string, unknown>) => {
  const input = `${enc({ alg: 'RS256', kid: s.kid, typ: 'JWT' })}.${enc(claims)}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', s.priv, new TextEncoder().encode(input));
  return `${input}.${Buffer.from(sig).toString('base64url')}`;
};
const wallet = (n: number) => {
  const priv = new PrivateKey(n);
  return Object.assign(new ProtoWallet(priv), { key: priv.toPublicKey().toString() });
};
const bindingFrom = async (w: ReturnType<typeof wallet>, alias: string, seq: number) => {
  const r = await signRequest(w, 'bind', { alias, seq: String(seq) });
  return { alias, identityKey: r.identityKey, seq, timestamp: String(r.timestamp), signature: r.signature };
};
const handedOver = async (from: ReturnType<typeof wallet>, to: ReturnType<typeof wallet>, alias: string, seq: number) => {
  const rel = await signRequest(from, 'release', { alias, to: to.key, seq: String(seq) });
  return {
    ...(await bindingFrom(to, alias, seq)),
    handover: { from: from.key, releaseSignature: rel.signature, releaseTimestamp: String(rel.timestamp) },
  };
};

const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const OURS = {
  capabilities: {
    pki: 'https://pay.bwallet.space/api/paymail/id/{alias}@{domain.tld}',
    '2a40af698840': 'https://pay.bwallet.space/api/p2p/{alias}@{domain.tld}',
    '5c55a7fdb7bb': 'https://pay.bwallet.space/api/beef/{alias}@{domain.tld}',
  },
};
/** A paymail host answering `id` for every name, with Google publishing `live` right now. */
const host = (id: unknown, live: ProviderKey[]): Fetch => {
  const routes: Record<string, unknown> = {
    'https://dns.google.com/resolve?name=_bsvalias._tcp.bwallet.space': { Status: 3 },
    'https://bwallet.space/.well-known/bsvalias': OURS,
    'https://pay.bwallet.space/api/paymail/id/': id,
    [GOOGLE_JWKS]: { keys: live.map((k) => k.jwk) },
  };
  return async (url) => {
    const hit = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((k) => url.startsWith(k));
    return hit === undefined
      ? new Response('{}', { status: 404 })
      : new Response(JSON.stringify(routes[hit]), { status: 200 });
  };
};

const mem = new Map<string, string>();
const realStorage = globalThis.localStorage;
const g = globalThis as { __GOOGLE_CLIENT_ID__?: string };
let google: Signer; // a real Google key, published now
let rotated: Signer; // a real Google key this wallet saw before Google rotated it out
let attacker: Signer; // the paymail server's own RSA key
const iat = 1_761_600_000;
const claimsFor = async (identityKey: string, email = 'victim@gmail.com') => ({
  iss: 'https://accounts.google.com',
  aud: AUD,
  sub: '1111',
  email,
  email_verified: true,
  nonce: await proofNonce(identityKey),
  iat,
  exp: iat + 3600,
});

beforeAll(async () => {
  google = await makeKey('g-live');
  rotated = await makeKey('g-rotated');
  attacker = await makeKey('evil-1');
  g.__GOOGLE_CLIENT_ID__ = AUD;
  globalThis.localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: () => null,
    length: 0,
  } as Storage;
});
afterAll(() => {
  delete g.__GOOGLE_CLIENT_ID__;
  globalThis.localStorage = realStorage;
  resetProviderKeyCache();
});
beforeEach(() => {
  mem.clear();
  resetProviderKeyCache();
});

describe('hostile pki: archived keys and firstSeen from the server are not trusted (row 357)', () => {
  const forgedAnswer = async (evil: ReturnType<typeof wallet>) => ({
    handle: 'victim.gmail@bwalletx.com',
    pubkey: evil.key,
    binding: await bindingFrom(evil, 'victim.gmail', 1),
    proof: {
      provider: 'google',
      idToken: await signJwt(attacker, await claimsFor(evil.key)),
      // The server's own key, "archived" with a backdated firstSeen.
      keys: [{ ...attacker.pub, firstSeen: new Date((iat - 86_400) * 1000).toISOString() }],
    },
  });

  test('first-time payer: the forged proof is never "proven" (pays at most as an unproven name)', async () => {
    const evil = wallet(901);
    const r = await resolveRecipient(host(await forgedAnswer(evil), [google.pub]), parseRecipient('victim.gmail@bwallet.space'));
    expect(r.nameProof?.status).not.toBe('proven');
    expect(r.nameProof?.status).toBe('unproven');
  });

  test('payer who saw the genuine proof before: the forged proof stops the payment', async () => {
    trustProofSub('victim.gmail', '1111');
    const evil = wallet(902);
    const r = await resolveRecipient(host(await forgedAnswer(evil), [google.pub]), parseRecipient('victim.gmail@bwallet.space'));
    expect(r.nameProof?.status).not.toBe('proven');
    expect(destinationFor(r, 'bsv').ok).toBe(false);
  });

  test("a key this wallet saw at Google itself still checks an older token after Google rotates it out", async () => {
    const owner = wallet(903);
    const answer = {
      handle: 'victim.gmail@bwalletx.com',
      pubkey: owner.key,
      binding: await bindingFrom(owner, 'victim.gmail', 1),
      proof: { provider: 'google', idToken: await signJwt(rotated, await claimsFor(owner.key)), keys: [] },
    };
    // While the key is published: proven, and the wallet keeps its own copy of the key.
    let r = await resolveRecipient(host(answer, [rotated.pub, google.pub]), parseRecipient('victim.gmail@bwallet.space'));
    expect(r.nameProof?.status).toBe('proven');
    // Google rotates it out; the server sends nothing (or garbage): the wallet's own copy still proves it.
    resetProviderKeyCache();
    r = await resolveRecipient(host(answer, [google.pub]), parseRecipient('victim.gmail@bwallet.space'));
    expect(r.nameProof?.status).toBe('proven');
  });

  test('a rotated key known only from the server is not used, even with an early firstSeen', async () => {
    const owner = wallet(904);
    const early = { ...rotated.pub, firstSeen: new Date((iat - 86_400) * 1000).toISOString() };
    const answer = {
      handle: 'victim.gmail@bwalletx.com',
      pubkey: owner.key,
      binding: await bindingFrom(owner, 'victim.gmail', 1),
      proof: { provider: 'google', idToken: await signJwt(rotated, await claimsFor(owner.key)), keys: [early] },
    };
    const r = await resolveRecipient(host(answer, [google.pub]), parseRecipient('victim.gmail@bwallet.space'));
    expect(r.nameProof?.status).toBe('unproven');
  });
});

describe('provider token validity (row 391)', () => {
  const opts = async (identityKey: string) => ({
    provider: 'google' as const,
    alias: 'victim.gmail',
    identityKey,
    aud: AUD,
    live: [google.pub],
    now: (iat + 600) * 1000,
  });
  test('a token whose exp is before its iat is refused (the reported forgery shape)', async () => {
    const k = wallet(911).key;
    const t = await signJwt(google, { ...(await claimsFor(k)), exp: iat - 3600 });
    expect((await verifyNameProof(t, await opts(k))).ok).toBe(false);
  });
  test('a token with no exp, a validity over a day, or issued in the future is refused', async () => {
    const k = wallet(912).key;
    const c = await claimsFor(k);
    const { exp: _drop, ...noExp } = c;
    expect((await verifyNameProof(await signJwt(google, noExp), await opts(k))).ok).toBe(false);
    expect((await verifyNameProof(await signJwt(google, { ...c, exp: iat + 30 * 86_400 }), await opts(k))).ok).toBe(false);
    const future = { ...c, iat: iat + 86_400, exp: iat + 86_400 + 3600 };
    expect((await verifyNameProof(await signJwt(google, future), await opts(k))).ok).toBe(false);
  });
  test('a well-formed token still proves the name', async () => {
    const k = wallet(913).key;
    expect(await verifyNameProof(await signJwt(google, await claimsFor(k)), await opts(k))).toEqual({
      ok: true,
      sub: '1111',
    });
  });
});

describe('binding seq replay (row 136)', () => {
  test('an older binding (lower seq) carrying a real old handover is a key change, not a handover', async () => {
    const a = wallet(921);
    const b = wallet(922);
    // History: a (seq 1) -> b (seq 2) -> back to a (seq 3). The payer paid a at seq 3.
    trustCurrentKey('shop', a.key, 3);
    expect(keyChange('shop', b.key, 'signed', a.key, 2)).toBe('changed'); // replayed a -> b at seq 2
    expect(keyChange('shop', b.key, 'signed', a.key, 3)).toBe('changed'); // equal seq, different key
    expect(keyChange('shop', b.key, 'signed', a.key, 4)).toBe('signed'); // a real new handover
    expect(keyChange('shop', a.key, 'signed', undefined, 3)).toBe('signed'); // the same binding again
  });

  test('end to end: the host replays the seq-2 handover after the payer paid at seq 3; Send stops', async () => {
    const a = wallet(931);
    const b = wallet(932);
    const now = await handedOver(b, a, 'shop2', 3); // b handed it back to a at seq 3
    const r0 = await resolveRecipient(
      host({ handle: 'shop2@bwalletx.com', pubkey: a.key, binding: now }, [google.pub]),
      parseRecipient('shop2@bwallet.space'),
    );
    expect(r0.nameBinding).toBe('signed');
    trustResolvedKey(r0); // the payer confirmed a payment
    const old = await handedOver(a, b, 'shop2', 2); // the real, older a -> b handover
    const r = await resolveRecipient(
      host({ handle: 'shop2@bwalletx.com', pubkey: b.key, binding: old }, [google.pub]),
      parseRecipient('shop2@bwallet.space'),
    );
    expect(r.nameBinding).toBe('changed');
    expect(destinationFor(r, 'bsv')).toEqual({ ok: false, error: KEY_CHANGED });
  });
});
