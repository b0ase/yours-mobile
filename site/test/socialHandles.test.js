// .github / .linkedin handles and their proofs (owner, 28 Oct 2026). Local keys and a throwaway seal key only.
import { describe, expect, test } from 'bun:test';
import crypto from 'crypto';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import pm from '../lib/paymail.js';
import social from '../lib/social.js';
import np from '../lib/nameProof.js';

const AUD = 'li-test-client';
const ENV = { PAYMAIL_DOMAIN: 'pay.test', SOCIAL_SEAL_KEY: 'cd'.repeat(32), LINKEDIN_CLIENT_ID: AUD };
const memStore = () => {
  const aliases = new Map();
  const pays = new Map();
  return {
    aliases,
    pays,
    getAlias: async (a) => aliases.get(a) ?? null,
    getAliasByKey: async (k) =>
      [...aliases.values()].find((r) => r.identity_key === k && (r.kind ?? 'plain') === 'plain') ??
      [...aliases.values()].find((r) => r.identity_key === k) ??
      null,
    countUncollected: async (a) => [...pays.values()].filter((p) => p.alias === a && p.status === 'received').length,
    deleteAlias: async (a) => {
      for (const [r, p] of pays) if (p.alias === a) pays.delete(r);
      aliases.delete(a);
    },
    appsStore: new Map(),
    getApps: async function (k) {
      return this.appsStore.get(k) ?? [];
    },
    setApps: async function (k, a) {
      this.appsStore.set(k, a);
    },
    listSocial: async (kind) =>
      [...aliases.values()]
        .filter((r) => (r.kind ?? 'plain') === kind)
        .map((r) => ({ alias: r.alias, display_name: r.display_name ?? null })),
    listByKey: async (k) => [...aliases.values()].filter((r) => r.identity_key === k),
    getAliasByKeyKind: async (k, kind) =>
      [...aliases.values()].find((r) => r.identity_key === k && (r.kind ?? 'plain') === kind) ?? null,
    upsertAlias: async (r) => (aliases.set(r.alias, { ...r }), r),
    renameAlias: async (from, to) => {
      const r = aliases.get(from);
      aliases.delete(from);
      aliases.set(to, { ...r, alias: to });
      for (const p of pays.values()) if (p.alias === from) p.alias = to;
    },
    forwards: new Map(),
    getForward: async function (a) {
      return this.forwards.get(a) ?? null;
    },
    putForward: async function (r) {
      this.forwards.set(r.from_alias, { ...r });
    },
    deleteForward: async function (a) {
      this.forwards.delete(a);
    },
    retargetForwards: async function (from, to) {
      for (const r of this.forwards.values()) if (r.to_alias === from) r.to_alias = to;
    },
    insertPayment: async (r) => void pays.set(r.reference, { ...r }),
    getPayment: async (ref) => pays.get(ref) ?? null,
    updatePayment: async (ref, patch) => void Object.assign(pays.get(ref), patch),
    listInbox: async (k) => [...pays.values()].filter((p) => p.identity_key === k && p.status === 'received'),
    listHistory: async (k) => [...pays.values()].filter((p) => p.identity_key === k),
    countRecentPayments: async () => 0,
    deleteByKey: async (k) => {
      let a = 0;
      let p = 0;
      for (const [key, r] of aliases) if (r.identity_key === k) (aliases.delete(key), a++);
      for (const [ref, r] of pays) if (r.identity_key === k) (pays.delete(ref), p++);
      return { aliases: a, payments: p };
    },
  };
};

const user = () => {
  const priv = PrivateKey.fromRandom();
  const wallet = new ProtoWallet(priv);
  const identityKey = priv.toPublicKey().toString();
  const sign = async (action, fields, timestamp = Date.now()) => {
    const all = { ...fields, identityKey, timestamp: String(timestamp) };
    const { signature } = await wallet.createSignature({
      data: Utils.toArray(pm.signedMessage(action, all), 'utf8'),
      protocolID: pm.SIGN_PROTOCOL,
      keyID: pm.SIGN_KEY_ID,
      counterparty: 'anyone',
    });
    return { identityKey, timestamp, fields, signature: Utils.toHex(signature) };
  };
  return { priv, identityKey, sign };
};

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
const ticket = (o, secret = 's3') => social.seal({ vh: social.sha256Hex(secret), e: Date.now() + 60_000, ...o }, ENV);
const withProofs = (s) => {
  s.proofs = new Map();
  s.log = [];
  s.getProof = async (a) => s.proofs.get(a) ?? null;
  s.getProofBySub = async (p, sub) => [...s.proofs.values()].find((x) => x.provider === p && x.sub === sub) ?? null;
  s.putProof = async (p) => void s.proofs.set(p.alias, { ...p });
  s.logName = async (r) => void s.log.push({ ...r, created_at: new Date().toISOString() });
  s.providerKeys = async (alias) => s.log.filter((r) => r.alias === alias && r.action === 'jwks');
  return s;
};

describe('social name rules', () => {
  test('socialAliasFor: github login, x, gmail; linkedin proves no name by itself', () => {
    expect(social.socialAliasFor('github', 'Octo-Cat')).toBe('octo-cat.github');
    expect(social.socialAliasFor('github', '-bad')).toBeNull();
    expect(social.socialAliasFor('github', 'a'.repeat(31))).toBeNull();
    expect(social.socialAliasFor('google', 'rich.ard+x@gmail.com')).toBe('richard.gmail');
    expect(social.socialAliasFor('linkedin', 'abc')).toBeNull();
  });
  test('linkedinSlug: from the display name, accents dropped', () => {
    expect(social.linkedinSlug('Richard Boase')).toBe('richardboase');
    expect(social.linkedinSlug('José Núñez')).toBe('josenunez');
    expect(social.linkedinSlug('')).toBeNull();
  });
  test('github / linkedin are system suffixes and reserved bases still apply', () => {
    expect(pm.SYSTEM_TLDS).toContain('github');
    expect(pm.SYSTEM_TLDS).toContain('linkedin');
  });
});

describe('.github names', () => {
  test('only a GitHub sign-in for exactly that login claims it', async () => {
    const store = withProofs(memStore());
    const h = pm.makeHandlers({ store, env: ENV });
    const u = user();
    const t = ticket({ p: 'github', id: '42', name: 'octo-cat' });
    const other = ticket({ p: 'github', id: '43', name: 'someone' });
    const x = ticket({ p: 'x', id: '1', name: 'octo-cat' });
    const reg = async (social) =>
      (await h.register({}, { ...(await u.sign('register', { alias: 'octo-cat.github' })), social }))[0];
    expect(await reg(undefined)).toBe(403);
    expect(await reg({ ticket: other, secret: 's3' })).toBe(403);
    expect(await reg({ ticket: x, secret: 's3' })).toBe(403);
    expect(await reg({ ticket: t, secret: 'wrong' })).toBe(403);
    expect(await reg({ ticket: t, secret: 's3' })).toBe(200);
    expect(store.aliases.get('octo-cat.github').kind).toBe('github');
  });
  test('gist proof: statement + signature by the key; owner login must match', async () => {
    const u = user();
    const alias = 'octo-cat.github';
    const st = np.gistStatement(alias, u.identityKey);
    const { signature } = await new ProtoWallet(u.priv).createSignature({
      data: Utils.toArray(st, 'utf8'),
      protocolID: pm.SIGN_PROTOCOL,
      keyID: pm.SIGN_KEY_ID,
      counterparty: 'anyone',
    });
    const text = `${st}\n${Utils.toHex(signature)}\n`;
    expect(await np.verifyGistText(text, alias, u.identityKey)).toBe(true);
    expect(await np.verifyGistText(text, alias, user().identityKey)).toBe(false);
    const gist = (login) => async () => ({
      ok: true,
      json: async () => ({
        owner: { login, id: 42 },
        html_url: 'https://gist.github.com/x/abc',
        files: { 'p.txt': { content: text } },
      }),
    });
    const id = 'a'.repeat(32);
    expect((await np.checkGist(id, alias, u.identityKey, gist('Octo-Cat'))).ok).toBe(true);
    expect((await np.checkGist(id, alias, u.identityKey, gist('mallory'))).ok).toBe(false);
    expect((await np.checkGist('not a gist', alias, u.identityKey, gist('Octo-Cat'))).ok).toBe(false);
  });
  test('prove-gist stores a github proof served on pki', async () => {
    const store = withProofs(memStore());
    const u = user();
    await store.upsertAlias({ kind: 'github', alias: 'octo-cat.github', identity_key: u.identityKey });
    const gistCheck = async () => ({
      ok: true,
      sub: '42',
      login: 'octo-cat',
      gist: 'g1',
      url: 'https://gist.github.com/g1',
    });
    const h = pm.makeHandlers({ store, env: ENV, gistCheck });
    const [s, r] = await h['prove-gist']({}, await u.sign('prove-gist', { alias: 'octo-cat.github', gist: 'g1' }));
    expect(s).toBe(200);
    expect(r.proof.provider).toBe('github');
    expect(r.proof.gist).toBe('g1');
    const pki = (await h.pki({ handle: 'octo-cat.github@pay.test' }))[1];
    expect(pki.proof.statement).toBe(np.gistStatement('octo-cat.github', u.identityKey));
    const v = user();
    expect((await h['prove-gist']({}, await v.sign('prove-gist', { alias: 'octo-cat.github', gist: 'g1' })))[0]).toBe(
      403,
    );
  });
});

describe('.linkedin names', () => {
  const k = rsa('li1');
  const claims = (identityKey, sub = 'li-sub-1') => ({
    iss: 'https://www.linkedin.com/oauth',
    aud: AUD,
    sub,
    name: 'Richard Boase',
    nonce: np.proofNonce(identityKey),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const liTicket = (identityKey, sub) =>
    ticket({
      p: 'linkedin',
      id: sub || 'li-sub-1',
      name: sub || 'li-sub-1',
      d: 'Richard Boase',
      it: jwt(k, claims(identityKey, sub)),
      pk: identityKey,
    });
  test('claim needs a LinkedIn-signed token for this wallet; binds the account; one name per account', async () => {
    const store = withProofs(memStore());
    const h = pm.makeHandlers({ store, env: ENV, providerJwks: async () => [k.pub] });
    const u = user();
    const v = user();
    const reg = async (w, alias, t) =>
      (await h.register({}, { ...(await w.sign('register', { alias })), social: t && { ticket: t, secret: 's3' } }))[0];
    // A ticket made for another wallet's key is refused.
    expect(await reg(u, 'richardboase.linkedin', liTicket(v.identityKey))).toBe(403);
    expect(await reg(u, 'richardboase.linkedin', liTicket(u.identityKey))).toBe(200);
    expect(store.proofs.get('richardboase.linkedin').sub).toBe('li-sub-1');
    expect(store.aliases.get('richardboase.linkedin').kind).toBe('linkedin');
    // The same LinkedIn account can't take a second .linkedin name.
    expect(await reg(v, 'rboase.linkedin', liTicket(v.identityKey))).toBe(409);
    // pki serves the proof.
    expect((await h.pki({ handle: 'richardboase.linkedin@pay.test' }))[1].proof.provider).toBe('linkedin');
  });
});
