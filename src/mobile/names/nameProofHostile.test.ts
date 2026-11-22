import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet } from '@bsv/sdk';
import { keyChange, trustCurrentKey } from './binding';
import {
  KEY_CHANGED,
  destinationFor,
  parseRecipient,
  proofKeyOverride,
  resolveRecipient,
  trustProvenAccount,
  trustResolvedKey,
  type Fetch,
} from './names';
import { signRequest } from './paymail';
import {
  proofNonce,
  provenKeyFor,
  resetProviderKeyCache,
  trustProofSub,
  verifyNameProof,
  type ProviderKey,
} from './proof';

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
const handedOver = async (
  from: ReturnType<typeof wallet>,
  to: ReturnType<typeof wallet>,
  alias: string,
  seq: number,
) => {
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
const claimsFor = async (identityKey: string, email = 'victim@gmail.com', at = iat) => ({
  iss: 'https://accounts.google.com',
  aud: AUD,
  sub: '1111',
  email,
  email_verified: true,
  nonce: await proofNonce(identityKey),
  iat: at,
  exp: at + 3600,
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
    const r = await resolveRecipient(
      host(await forgedAnswer(evil), [google.pub]),
      parseRecipient('victim.gmail@bwallet.space'),
    );
    expect(r.nameProof?.status).not.toBe('proven');
    expect(r.nameProof?.status).toBe('unproven');
  });

  test('payer who saw the genuine proof before: the forged proof stops the payment', async () => {
    trustProofSub('victim.gmail', '1111');
    const evil = wallet(902);
    const r = await resolveRecipient(
      host(await forgedAnswer(evil), [google.pub]),
      parseRecipient('victim.gmail@bwallet.space'),
    );
    expect(r.nameProof?.status).not.toBe('proven');
    expect(destinationFor(r, 'bsv').ok).toBe(false);
  });

  test('a key this wallet saw at Google itself still checks an older token after Google rotates it out', async () => {
    const owner = wallet(903);
    const answer = {
      handle: 'victim.gmail@bwalletx.com',
      pubkey: owner.key,
      binding: await bindingFrom(owner, 'victim.gmail', 1),
      proof: { provider: 'google', idToken: await signJwt(rotated, await claimsFor(owner.key)), keys: [] },
    };
    // While the key is published: proven, and the wallet keeps its own copy of the key.
    let r = await resolveRecipient(
      host(answer, [rotated.pub, google.pub]),
      parseRecipient('victim.gmail@bwallet.space'),
    );
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

describe('a proof key this wallet never saw, for a name it saw proven before (review finding 1)', () => {
  // The wallet saw the name proven (at a lookup, through the server's old archive) but never paid it and never kept
  // a copy of the key; Google has since rotated that key out. Send stops; the payer needs a deliberate way through.
  const oldProof = async (owner: ReturnType<typeof wallet>) => ({
    handle: 'victim.gmail@bwalletx.com',
    pubkey: owner.key,
    binding: await bindingFrom(owner, 'victim.gmail', 1),
    proof: { provider: 'google', idToken: await signJwt(rotated, await claimsFor(owner.key)), keys: [] },
  });

  test('the payer gets an "I\'ve checked with them" override, and using it makes the name payable (no badge)', async () => {
    trustProofSub('victim.gmail', '1111');
    const owner = wallet(941);
    const answer = await oldProof(owner);
    let r = await resolveRecipient(host(answer, [google.pub]), parseRecipient('victim.gmail@bwallet.space'));
    expect(r.nameProof?.status).toBe('unchecked');
    expect(destinationFor(r, 'bsv').ok).toBe(false);
    expect(proofKeyOverride(r)).toBe(true);
    trustResolvedKey(r); // what the override button does
    resetProviderKeyCache();
    r = await resolveRecipient(host(answer, [google.pub]), parseRecipient('victim.gmail@bwallet.space'));
    expect(r.nameProof?.status).toBe('unproven');
    expect(destinationFor(r, 'bsv').ok).toBe(true);
    expect(proofKeyOverride(r)).toBe(false);
  });

  test('no override for other stops: a proven name, a bad binding, or a key change (that one has its own button)', async () => {
    const owner = wallet(942);
    const r = await resolveRecipient(
      host(await oldProof(owner), [rotated.pub, google.pub]),
      parseRecipient('victim.gmail@bwallet.space'),
    );
    expect(r.nameProof?.status).toBe('proven');
    expect(proofKeyOverride(r)).toBe(false);
    const unchecked = {
      ...r,
      nameProof: {
        status: 'unchecked' as const,
        provider: 'google' as const,
        reason: 'unknown signing key',
        alias: 'victim.gmail',
        overridable: true,
      },
    };
    expect(proofKeyOverride(unchecked)).toBe(true);
    expect(proofKeyOverride({ ...unchecked, nameBinding: 'bad' })).toBe(false);
    expect(proofKeyOverride({ ...unchecked, nameBinding: 'mismatch' })).toBe(false);
    expect(proofKeyOverride({ ...unchecked, nameBinding: 'changed' })).toBe(false);
    expect(proofKeyOverride({ ...unchecked, pubkey: undefined })).toBe(false);
    // "This version can't check proofs" (no client id) is not a key we could re-trust.
    expect(proofKeyOverride({ ...unchecked, nameProof: { status: 'unchecked', provider: 'google' } })).toBe(false);
    // A name this wallet already holds a proven wallet key for: no override (second review, finding 1).
    expect(proofKeyOverride({ ...unchecked, nameProof: { ...unchecked.nameProof, overridable: undefined } })).toBe(
      false,
    );
  });
});

describe('second review: a hostile server can not turn a proven name into a tap-through (finding 1)', () => {
  const genuine = async (owner: ReturnType<typeof wallet>) => ({
    handle: 'victim.gmail@bwalletx.com',
    pubkey: owner.key,
    binding: await bindingFrom(owner, 'victim.gmail', 1),
    proof: { provider: 'google', idToken: await signJwt(google, await claimsFor(owner.key)), keys: [] },
  });
  // The attacker's wallet and binding, with a token under a kid Google never published.
  const hostile = async (evil: ReturnType<typeof wallet>) => ({
    handle: 'victim.gmail@bwalletx.com',
    pubkey: evil.key,
    binding: await bindingFrom(evil, 'victim.gmail', 1),
    proof: { provider: 'google', idToken: await signJwt(attacker, await claimsFor(evil.key)), keys: [] },
  });
  const pr = () => parseRecipient('victim.gmail@bwallet.space');

  test('seen proven, never paid: the attacker key under an unknown kid stops Send with no override', async () => {
    const owner = wallet(951);
    expect((await resolveRecipient(host(await genuine(owner), [google.pub]), pr())).nameProof?.status).toBe('proven');
    resetProviderKeyCache();
    const r = await resolveRecipient(host(await hostile(wallet(952)), [google.pub]), pr());
    expect(r.nameProof?.status).toBe('unchecked');
    expect(destinationFor(r, 'bsv').ok).toBe(false);
    expect(proofKeyOverride(r)).toBe(false);
  });

  test('seen proven and paid: the key-change override does not also wave the proof stop through', async () => {
    const owner = wallet(953);
    const r0 = await resolveRecipient(host(await genuine(owner), [google.pub]), pr());
    expect(r0.nameProof?.status).toBe('proven');
    trustResolvedKey(r0); // the payer paid the genuine owner
    resetProviderKeyCache();
    const answer = await hostile(wallet(954));
    let r = await resolveRecipient(host(answer, [google.pub]), pr());
    expect(r.nameBinding).toBe('changed');
    expect(r.nameProof?.status).toBe('unchecked');
    trustResolvedKey(r); // "I've checked with them: trust the new wallet"
    resetProviderKeyCache();
    r = await resolveRecipient(host(answer, [google.pub]), pr());
    expect(r.nameProof?.status).toBe('unchecked');
    expect(destinationFor(r, 'bsv').ok).toBe(false);
    expect(proofKeyOverride(r)).toBe(false);
  });

  test('seen proven, never paid: the SAME wallet key with a token this wallet cannot check pays as unproven', async () => {
    const owner = wallet(955);
    expect((await resolveRecipient(host(await genuine(owner), [google.pub]), pr())).nameProof?.status).toBe('proven');
    resetProviderKeyCache();
    const unknownKid = await makeKey('g-never-seen');
    const answer = {
      ...(await genuine(owner)),
      proof: { provider: 'google', idToken: await signJwt(unknownKid, await claimsFor(owner.key)), keys: [] },
    };
    const r = await resolveRecipient(host(answer, [google.pub]), pr());
    expect(r.nameProof?.status).toBe('unproven');
    expect(destinationFor(r, 'bsv').ok).toBe(true);
    expect(proofKeyOverride(r)).toBe(false);
  });
});

describe('second review: the override works for a forwarded name (finding 2)', () => {
  const signedForward = async (w: ReturnType<typeof wallet>, from: string, to: string) => {
    const r = await signRequest(w, 'forward', { from, to, expiresAt: '' });
    return {
      from: `${from}@bwalletx.com`,
      to: `${to}@bwalletx.com`,
      expiresAt: null,
      identityKey: r.identityKey,
      timestamp: String(r.timestamp),
      signature: r.signature,
      fromBinding: await bindingFrom(w, from, 1),
    };
  };

  test('boase@ forwards to victim.gmail@ (proof key unknown, name seen proven before the update): one tap gets through', async () => {
    trustProofSub('victim.gmail', '1111'); // seen proven before this update: no wallet key kept for it
    const owner = wallet(961);
    const answer = {
      handle: 'victim.gmail@bwalletx.com',
      pubkey: owner.key,
      binding: await bindingFrom(owner, 'victim.gmail', 1),
      forward: await signedForward(owner, 'boase', 'victim.gmail'),
      proof: { provider: 'google', idToken: await signJwt(rotated, await claimsFor(owner.key)), keys: [] },
    };
    let r = await resolveRecipient(host(answer, [google.pub]), parseRecipient('boase@bwallet.space'));
    expect(r.forwardsTo).toBe('victim.gmail');
    expect(r.nameProof?.status).toBe('unchecked');
    expect(proofKeyOverride(r)).toBe(true);
    trustResolvedKey(r); // what the override button does
    resetProviderKeyCache();
    r = await resolveRecipient(host(answer, [google.pub]), parseRecipient('boase@bwallet.space'));
    expect(r.nameProof?.status).toBe('unproven');
    expect(destinationFor(r, 'bsv').ok).toBe(true);
  });

  test('a forwarded name proven by a new account: "trust the new account" is kept for the proven name', async () => {
    trustProofSub('victim.gmail', '0000'); // an older account
    const owner = wallet(962);
    const answer = {
      handle: 'victim.gmail@bwalletx.com',
      pubkey: owner.key,
      binding: await bindingFrom(owner, 'victim.gmail', 1),
      forward: await signedForward(owner, 'boase', 'victim.gmail'),
      proof: { provider: 'google', idToken: await signJwt(google, await claimsFor(owner.key)), keys: [] },
    };
    let r = await resolveRecipient(host(answer, [google.pub]), parseRecipient('boase@bwallet.space'));
    expect(r.nameProof?.status).toBe('sub-changed');
    trustProvenAccount(r); // what "I've checked with them: trust the new account" does
    resetProviderKeyCache();
    r = await resolveRecipient(host(answer, [google.pub]), parseRecipient('boase@bwallet.space'));
    expect(r.nameProof?.status).toBe('proven');
    expect(destinationFor(r, 'bsv').ok).toBe(true);
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
    expect((await verifyNameProof(await signJwt(google, { ...c, exp: iat + 30 * 86_400 }), await opts(k))).ok).toBe(
      false,
    );
    const future = { ...c, iat: iat + 86_400, exp: iat + 86_400 + 3600 };
    expect((await verifyNameProof(await signJwt(google, future), await opts(k))).ok).toBe(false);
  });
  test('a well-formed token still proves the name', async () => {
    const k = wallet(913).key;
    expect(await verifyNameProof(await signJwt(google, await claimsFor(k)), await opts(k))).toEqual({
      ok: true,
      sub: '1111',
      iat,
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

describe('third review: a signed handover from the kept key (finding 1)', () => {
  const pr = () => parseRecipient('victim.gmail@bwallet.space');
  const answerFor = async (w: ReturnType<typeof wallet>, binding: unknown, signer: Signer) => ({
    handle: 'victim.gmail@bwalletx.com',
    pubkey: w.key,
    binding,
    proof: { provider: 'google', idToken: await signJwt(signer, await claimsFor(w.key)), keys: [] },
  });

  test('kept K0, owner hands over to K1 at a newer seq, K1 token under a kid Google no longer publishes: pays (no badge)', async () => {
    const k0 = wallet(971);
    const k1 = wallet(972);
    const r0 = await resolveRecipient(
      host(await answerFor(k0, await bindingFrom(k0, 'victim.gmail', 1), google), [google.pub]),
      pr(),
    );
    expect(r0.nameProof?.status).toBe('proven');
    resetProviderKeyCache();
    const gone = await makeKey('g-gone-971'); // signed K1's token; rotated out before this wallet looked
    const moved = await answerFor(k1, await handedOver(k0, k1, 'victim.gmail', 2), gone);
    let r = await resolveRecipient(host(moved, [google.pub]), pr());
    expect(r.nameBinding).toBe('signed');
    expect(r.nameProof?.status).toBe('unproven');
    expect(destinationFor(r, 'bsv').ok).toBe(true);
    // The handover moved the kept key to K1: K1's own later binding (no handover) still pays.
    resetProviderKeyCache();
    r = await resolveRecipient(
      host(await answerFor(k1, await bindingFrom(k1, 'victim.gmail', 3), gone), [google.pub]),
      pr(),
    );
    expect(r.nameProof?.status).toBe('unproven');
    expect(destinationFor(r, 'bsv').ok).toBe(true);
  });

  test('a real but older handover from the kept key, replayed with an uncheckable token, still stops', async () => {
    const a = wallet(973);
    const b = wallet(974);
    // History: a (seq 1) -> b (seq 2) -> back to a (seq 3). The wallet saw a proven at seq 3.
    const r0 = await resolveRecipient(
      host(await answerFor(a, await handedOver(b, a, 'victim.gmail', 3), google), [google.pub]),
      pr(),
    );
    expect(r0.nameProof?.status).toBe('proven');
    resetProviderKeyCache();
    const gone = await makeKey('g-gone-973');
    const r = await resolveRecipient(
      host(await answerFor(b, await handedOver(a, b, 'victim.gmail', 2), gone), [google.pub]),
      pr(),
    );
    expect(r.nameProof?.status).toBe('unchecked');
    expect(destinationFor(r, 'bsv').ok).toBe(false);
  });
});

describe('third review: the kept proven key never moves backwards (finding 2, replayed superseded key)', () => {
  const pr = () => parseRecipient('victim.gmail@bwallet.space');
  const answerFor = async (w: ReturnType<typeof wallet>, binding: unknown, signer: Signer = google, at = iat) => ({
    handle: 'victim.gmail@bwalletx.com',
    pubkey: w.key,
    binding,
    proof: { provider: 'google', idToken: await signJwt(signer, await claimsFor(w.key, undefined, at)), keys: [] },
  });
  /** K0 proven at seq 1, then K1 proven at seq 2 (a newer token): the server keeps K0's old binding and token. */
  const history = async (n: number) => {
    const k0 = wallet(n);
    const k1 = wallet(n + 1);
    const old = await answerFor(k0, await bindingFrom(k0, 'victim.gmail', 1));
    expect((await resolveRecipient(host(old, [google.pub]), pr())).nameProof?.status).toBe('proven');
    resetProviderKeyCache();
    const now = await answerFor(k1, await bindingFrom(k1, 'victim.gmail', 2), google, iat + 3600);
    expect((await resolveRecipient(host(now, [google.pub]), pr())).nameProof?.status).toBe('proven');
    resetProviderKeyCache();
    return { k0, k1, old, now };
  };

  test('replaying superseded K0 with its old token and seq-1 binding is not "proven", and Send stops', async () => {
    const { old } = await history(981);
    const r = await resolveRecipient(host(old, [google.pub]), pr());
    expect(r.nameProof?.status).not.toBe('proven');
    expect(destinationFor(r, 'bsv').ok).toBe(false);
  });

  test('replaying K0 with no binding, or at the same seq as K1, is not "proven" either', async () => {
    const { k0, old } = await history(983);
    let r = await resolveRecipient(host({ ...old, binding: undefined }, [google.pub]), pr());
    expect(r.nameProof?.status).not.toBe('proven');
    expect(destinationFor(r, 'bsv').ok).toBe(false);
    resetProviderKeyCache();
    r = await resolveRecipient(host({ ...old, binding: await bindingFrom(k0, 'victim.gmail', 2) }, [google.pub]), pr());
    expect(r.nameProof?.status).not.toBe('proven');
    expect(destinationFor(r, 'bsv').ok).toBe(false);
  });

  test('the replay does not move the kept key back to K0: K1 with an uncheckable token still pays', async () => {
    const { k1, old } = await history(985);
    await resolveRecipient(host(old, [google.pub]), pr());
    resetProviderKeyCache();
    const gone = await makeKey('g-gone-985');
    const r = await resolveRecipient(
      host(await answerFor(k1, await bindingFrom(k1, 'victim.gmail', 2), gone), [google.pub]),
      pr(),
    );
    expect(r.nameProof?.status).toBe('unproven');
    expect(destinationFor(r, 'bsv').ok).toBe(true);
  });

  test('the kept key itself served again (even at an older seq) is still proven, and a newer key is too', async () => {
    const { k1, now } = await history(987);
    let r = await resolveRecipient(
      host({ ...now, binding: await bindingFrom(k1, 'victim.gmail', 1) }, [google.pub]),
      pr(),
    );
    expect(r.nameProof?.status).toBe('proven');
    resetProviderKeyCache();
    const k2 = wallet(989);
    r = await resolveRecipient(
      host(await answerFor(k2, await bindingFrom(k2, 'victim.gmail', 3), google, iat + 7200), [google.pub]),
      pr(),
    );
    expect(r.nameProof?.status).toBe('proven');
  });
});

describe("fourth review: the kept key is ordered by the provider's own time, not only the self-signed seq", () => {
  const pr = () => parseRecipient('victim.gmail@bwallet.space');
  const answerFor = async (w: ReturnType<typeof wallet>, binding: unknown, at: number, signer: Signer = google) => ({
    handle: 'victim.gmail@bwalletx.com',
    pubkey: w.key,
    binding,
    proof: { provider: 'google', idToken: await signJwt(signer, await claimsFor(w.key, undefined, at)), keys: [] },
  });
  const resolve = async (answer: unknown) => {
    resetProviderKeyCache();
    return resolveRecipient(host(answer, [google.pub]), pr());
  };
  /** The kept key is still K1: K1 served with a token this wallet can't check pays (unproven), anything else stops. */
  const keptIsK1 = async (k1: ReturnType<typeof wallet>, seq?: number) => {
    const gone = await makeKey(`g-gone-${k1.key.slice(2, 10)}`);
    const binding = seq === undefined ? undefined : await bindingFrom(k1, 'victim.gmail', seq);
    const r = await resolve(await answerFor(k1, binding, iat + 3600, gone));
    expect(r.nameProof?.status).toBe('unproven');
    expect(destinationFor(r, 'bsv').ok).toBe(true);
  };

  test('finding 1: compromised K0 re-signs its own binding at seq 3 with its old token: not proven, Send stops', async () => {
    const k0 = wallet(1001);
    const k1 = wallet(1002);
    expect((await resolve(await answerFor(k0, await bindingFrom(k0, 'victim.gmail', 1), iat))).nameProof?.status).toBe(
      'proven',
    );
    const r1 = await resolve(await answerFor(k1, await bindingFrom(k1, 'victim.gmail', 2), iat + 3600));
    expect(r1.nameProof?.status).toBe('proven');
    // K0's holder signs a fresh binding at seq = kept + 1 and the server serves it with K0's old Google token.
    const r = await resolve(await answerFor(k0, await bindingFrom(k0, 'victim.gmail', 3), iat));
    expect(r.nameBinding).toBe('signed');
    expect(r.nameProof?.status).toBe('bad');
    expect(destinationFor(r, 'bsv').ok).toBe(false);
    // ...and the kept key did not move back to K0.
    expect(provenKeyFor('victim.gmail')?.key).toBe(k1.key.toLowerCase());
    await keptIsK1(k1, 2);
  });

  test('an honest newer proof still passes: K1 with a newer token, then back to K0 with a fresh token', async () => {
    const k0 = wallet(1011);
    const k1 = wallet(1012);
    expect((await resolve(await answerFor(k0, await bindingFrom(k0, 'victim.gmail', 1), iat))).nameProof?.status).toBe(
      'proven',
    );
    let r = await resolve(await answerFor(k1, await bindingFrom(k1, 'victim.gmail', 2), iat + 3600));
    expect(r.nameProof?.status).toBe('proven');
    expect(destinationFor(r, 'bsv').ok).toBe(true);
    r = await resolve(await answerFor(k0, await bindingFrom(k0, 'victim.gmail', 3), iat + 7200));
    expect(r.nameProof?.status).toBe('proven');
    expect(provenKeyFor('victim.gmail')).toEqual({ key: k0.key.toLowerCase(), seq: 3, at: iat + 7200 });
  });

  test('finding 2: names proven with no signed binding (no seq) still refuse the superseded key', async () => {
    const k0 = wallet(1021);
    const k1 = wallet(1022);
    expect((await resolve(await answerFor(k0, undefined, iat))).nameProof?.status).toBe('proven');
    expect((await resolve(await answerFor(k1, undefined, iat + 3600))).nameProof?.status).toBe('proven');
    let r = await resolve(await answerFor(k0, undefined, iat));
    expect(r.nameProof?.status).toBe('bad');
    expect(destinationFor(r, 'bsv').ok).toBe(false);
    r = await resolve(await answerFor(k0, await bindingFrom(k0, 'victim.gmail', 5), iat));
    expect(r.nameProof?.status).toBe('bad');
    expect(destinationFor(r, 'bsv').ok).toBe(false);
    await keptIsK1(k1);
  });

  test('finding 2: a key kept before this update gets its token time on the next proof, then refuses the replay', async () => {
    const k0 = wallet(1031);
    const k1 = wallet(1032);
    // What an earlier build kept: K1 at seq 2, no token time; and the Google account.
    mem.set('bwallet.names.proofKeys', JSON.stringify({ 'victim.gmail': { key: k1.key.toLowerCase(), seq: 2 } }));
    trustProofSub('victim.gmail', '1111');
    const r1 = await resolve(await answerFor(k1, await bindingFrom(k1, 'victim.gmail', 2), iat + 3600));
    expect(r1.nameProof?.status).toBe('proven');
    expect(provenKeyFor('victim.gmail')?.at).toBe(iat + 3600);
    const r = await resolve(await answerFor(k0, await bindingFrom(k0, 'victim.gmail', 3), iat));
    expect(r.nameProof?.status).toBe('bad');
    expect(destinationFor(r, 'bsv').ok).toBe(false);
  });

  test('a signed handover keeps the token-time floor: K0 replayed after K0 -> K1 still stops', async () => {
    const k0 = wallet(1041);
    const k1 = wallet(1042);
    expect((await resolve(await answerFor(k0, await bindingFrom(k0, 'victim.gmail', 1), iat))).nameProof?.status).toBe(
      'proven',
    );
    // The owner hands over to K1; K1's token is under a kid this wallet never saw, so it pays unproven.
    const gone = await makeKey('g-gone-1041');
    const moved = await resolve(await answerFor(k1, await handedOver(k0, k1, 'victim.gmail', 2), iat + 3600, gone));
    expect(moved.nameProof?.status).toBe('unproven');
    const r = await resolve(await answerFor(k0, await bindingFrom(k0, 'victim.gmail', 3), iat));
    expect(r.nameProof?.status).toBe('bad');
    expect(destinationFor(r, 'bsv').ok).toBe(false);
  });
});

describe('fifth review: a handover or override sets the time floor to when this wallet accepted it', () => {
  const pr = () => parseRecipient('victim.gmail@bwallet.space');
  const answerFor = async (w: ReturnType<typeof wallet>, binding: unknown, at: number, signer: Signer = google) => ({
    handle: 'victim.gmail@bwalletx.com',
    pubkey: w.key,
    binding,
    proof: { provider: 'google', idToken: await signJwt(signer, await claimsFor(w.key, undefined, at)), keys: [] },
  });
  const resolve = async (answer: unknown) => {
    resetProviderKeyCache();
    return resolveRecipient(host(answer, [google.pub]), pr());
  };

  test('K0 kept, handover to K1 under an unknown kid, compromised K0 signs seq 3 with a later real K0 token: stops', async () => {
    const k0 = wallet(1051);
    const k1 = wallet(1052);
    // The server serves K0 with its oldest token (at = iat).
    expect((await resolve(await answerFor(k0, await bindingFrom(k0, 'victim.gmail', 1), iat))).nameProof?.status).toBe(
      'proven',
    );
    // Then the owner's real K0 -> K1 handover, with a token under a kid the server made itself: pays unproven.
    const evil = await makeKey('evil-1051');
    const moved = await resolve(await answerFor(k1, await handedOver(k0, k1, 'victim.gmail', 2), iat + 3600, evil));
    expect(moved.nameProof?.status).toBe('unproven');
    expect(provenKeyFor('victim.gmail')?.key).toBe(k1.key.toLowerCase());
    // Compromised K0 signs seq 3; the server serves a later real K0 token (a proof refresh before the handover).
    const r = await resolve(await answerFor(k0, await bindingFrom(k0, 'victim.gmail', 3), iat + 1800));
    expect(r.nameProof?.status).not.toBe('proven');
    expect(destinationFor(r, 'bsv').ok).toBe(false);
    expect(provenKeyFor('victim.gmail')?.key).toBe(k1.key.toLowerCase());
  });

  test('the handover floor is when this wallet followed it, never earlier than a provider time it kept', async () => {
    const k0 = wallet(1061);
    const k1 = wallet(1062);
    await resolve(await answerFor(k0, await bindingFrom(k0, 'victim.gmail', 1), iat));
    const evil = await makeKey('evil-1061');
    const before = Math.floor(Date.now() / 1000);
    await resolve(await answerFor(k1, await handedOver(k0, k1, 'victim.gmail', 2), iat + 3600, evil));
    expect(provenKeyFor('victim.gmail')?.at ?? 0).toBeGreaterThanOrEqual(before);
    // K1's own token, issued before the wallet followed the handover, still proves K1 (same key, no floor applies).
    const r = await resolve(await answerFor(k1, await bindingFrom(k1, 'victim.gmail', 2), iat + 3600));
    expect(r.nameProof?.status).toBe('proven');
    expect(provenKeyFor('victim.gmail')?.at ?? 0).toBeGreaterThanOrEqual(before);
    // A genuinely newer proof for another key (issued after the handover) still passes.
    const k2 = wallet(1063);
    const later = Math.floor(Date.now() / 1000) + 60;
    const r2 = await resolve(await answerFor(k2, await bindingFrom(k2, 'victim.gmail', 3), later));
    expect(r2.nameProof?.status).toBe('proven');
  });

  test("the payer's override sets the floor too: an older real token for another key can't take the name back", async () => {
    trustProofSub('victim.gmail', '1111');
    const x = wallet(1071);
    const y = wallet(1072);
    // Seen proven before, no kept key; X's token is under a kid this wallet never saw: the payer overrides.
    let r = await resolve(await answerFor(x, await bindingFrom(x, 'victim.gmail', 1), iat, rotated));
    expect(proofKeyOverride(r)).toBe(true);
    trustResolvedKey(r);
    expect(provenKeyFor('victim.gmail')?.key).toBe(x.key.toLowerCase());
    // The server then replays a real token for Y issued before the override, at a higher seq.
    r = await resolve(await answerFor(y, await bindingFrom(y, 'victim.gmail', 5), iat + 7200));
    expect(r.nameProof?.status).not.toBe('proven');
    expect(destinationFor(r, 'bsv').ok).toBe(false);
    expect(provenKeyFor('victim.gmail')?.key).toBe(x.key.toLowerCase());
  });
});
