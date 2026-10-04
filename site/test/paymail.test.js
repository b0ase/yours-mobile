import { describe, expect, test } from 'bun:test';
import { KeyDeriver, P2PKH, PrivateKey, ProtoWallet, Script, Transaction, Utils } from '@bsv/sdk';
import pm from '../lib/paymail.js';

const ENV = { PAYMAIL_DOMAIN: 'pay.test' };

const memStore = () => {
  const aliases = new Map();
  const pays = new Map();
  return {
    aliases,
    pays,
    getAlias: async (a) => aliases.get(a) ?? null,
    getAliasByKey: async (k) => [...aliases.values()].find((r) => r.identity_key === k) ?? null,
    upsertAlias: async (r) => (aliases.set(r.alias, { ...r }), r),
    renameAlias: async (from, to) => {
      const r = aliases.get(from);
      aliases.delete(from);
      aliases.set(to, { ...r, alias: to });
      for (const p of pays.values()) if (p.alias === from) p.alias = to;
    },
    insertPayment: async (r) => void pays.set(r.reference, { ...r }),
    getPayment: async (ref) => pays.get(ref) ?? null,
    updatePayment: async (ref, patch) => void Object.assign(pays.get(ref), patch),
    listInbox: async (k) => [...pays.values()].filter((p) => p.identity_key === k && p.status === 'received'),
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

describe('capabilities', () => {
  test('lists the bsvalias BRFCs on the configured domain', () => {
    const c = pm.capabilities(ENV).capabilities;
    expect(c.pki).toBe('https://pay.test/api/paymail/id/{alias}@{domain.tld}');
    for (const k of ['f12f968c92d6', 'a9f510c16bde', '2a40af698840', '5f1323cddf31', '5c55a7fdb7bb', 'ordAddress'])
      expect(c[k]).toContain('{alias}@{domain.tld}');
  });
  test('defaults to bwallet-nine.vercel.app', () => expect(pm.domain({})).toBe('bwallet-nine.vercel.app'));
  test('parseHandle only accepts our domain', () => {
    expect(pm.parseHandle('Alice@pay.test', ENV)).toBe('alice');
    expect(pm.parseHandle('alice@other.test', ENV)).toBeNull();
    expect(pm.parseHandle('-x@pay.test', ENV)).toBeNull();
  });
});

describe('register', () => {
  test('signed registration, then pki / verify / profile / ord', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const u = user();
    const ord = PrivateKey.fromRandom().toAddress();
    const [s, r] = await h.register({}, await u.sign('register', { alias: 'alice', ordAddress: ord, name: 'Alice' }));
    expect(s).toBe(200);
    expect(r.paymail).toBe('alice@pay.test');
    expect((await h.pki({ handle: 'alice@pay.test' }))[1].pubkey).toBe(u.identityKey);
    expect((await h.verify({ handle: 'alice@pay.test', pubkey: u.identityKey }))[1].match).toBe(true);
    expect((await h.verify({ handle: 'alice@pay.test', pubkey: '02' + '1'.repeat(64) }))[1].match).toBe(false);
    expect((await h.profile({ handle: 'alice@pay.test' }))[1].name).toBe('Alice');
    expect((await h.ord({ handle: 'alice@pay.test' }))[1].address).toBe(ord);
    expect((await h.lookup({ key: u.identityKey }))[1].paymail).toBe('alice@pay.test');
  });

  test('rejects a bad signature, an expired one, and someone else taking the alias', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const u = user();
    const body = await u.sign('register', { alias: 'bob' });
    expect((await h.register({}, { ...body, fields: { alias: 'eve' } }))[0]).toBe(401);
    expect((await h.register({}, await u.sign('register', { alias: 'bob' }, Date.now() - 600_000)))[0]).toBe(401);
    expect((await h.register({}, body))[0]).toBe(200);
    const v = user();
    expect((await h.register({}, await v.sign('register', { alias: 'bob' })))[0]).toBe(409);
    expect((await h.register({}, await v.sign('register', { alias: 'admin' })))[0]).toBe(400);
  });

  test('social names (b0asex.x, theirname.gmail) need bit-sign to confirm the key', async () => {
    const store = memStore();
    const allowed = new Map(); // alias → key bit-sign would confirm
    // Stands in for bit-sign's ticket check: the ticket names the X account it proved.
    const socialCheck = async (alias, social) => (social && allowed.get(alias) === social.ticket ? null : 'no');
    const h = pm.makeHandlers({ store, env: ENV, socialCheck });
    const u = user();
    const v = user();
    expect((await h.register({}, await u.sign('register', { alias: 'b0asex.x' })))[0]).toBe(403);
    allowed.set('b0asex.x', 'ticket-b0asex');
    const social = { ticket: 'ticket-b0asex', secret: 's' };
    expect((await h.register({}, { ...(await v.sign('register', { alias: 'b0asex.x' })), social: { ticket: 'other', secret: 's' } }))[0]).toBe(403);
    const [s, r] = await h.register({}, { ...(await u.sign('register', { alias: 'b0asex.x' })), social });
    expect(s).toBe(200);
    expect(r.paymail).toBe('b0asex.x@pay.test');
    expect((await h.pki({ handle: 'B0aseX.X@pay.test' }))[1].pubkey).toBe(u.identityKey);
    // Plain names never call bit-sign; a lookalike plain name stays separate.
    expect((await h.register({}, await v.sign('register', { alias: 'b0asex' })))[0]).toBe(200);
    // Once taken, the same X name can't be registered to a second wallet.
    expect((await h.register({}, { ...(await v.sign('register', { alias: 'b0asex.x' })), social }))[0]).toBe(409);
    expect(pm.socialAliasFor('x', 'B0ase_X')).toBe('b0ase-x.x');
    expect(pm.socialAliasFor('google', 'their.name+t@gmail.com')).toBe('theirname.gmail');
    expect(pm.socialAliasFor('google', 'a@corp.com')).toBeNull();
    expect((await h.register({}, await v.sign('register', { alias: 'evil.com' })))[0]).toBe(400);
  });

  test('one alias per identity: re-registering renames', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const u = user();
    await h.register({}, await u.sign('register', { alias: 'one' }));
    await h.register({}, await u.sign('register', { alias: 'two' }));
    expect(store.aliases.has('one')).toBe(false);
    expect(store.aliases.get('two').identity_key).toBe(u.identityKey);
  });
});

describe('P2P receive → inbox → wallet can spend', () => {
  test('end to end with BRC-29 derivation against the anyone key', async () => {
    const store = memStore();
    const broadcasts = [];
    const h = pm.makeHandlers({ store, env: ENV, broadcast: async (tx) => void broadcasts.push(tx.id('hex')) });
    const u = user();
    await h.register({}, await u.sign('register', { alias: 'carol' }));

    const [s, dest] = await h.p2pDestination({ handle: 'carol@pay.test' }, { satoshis: 1234 });
    expect(s).toBe(200);
    expect(dest.outputs).toHaveLength(1);

    // Sender builds a tx paying the destination (no inputs needed for this check).
    const tx = new Transaction();
    tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 5 });
    tx.addOutput({ lockingScript: new P2PKH().lock('1BoatSLRHtKNngkdXEeobR76b53LETtpyT'), satoshis: 1 });
    tx.addOutput({ lockingScript: Script.fromHex(dest.outputs[0].script), satoshis: 1234 });

    // Wrong amount is refused.
    const bad = new Transaction();
    bad.addOutput({ lockingScript: Script.fromHex(dest.outputs[0].script), satoshis: 1000 });
    expect((await h.receive({ handle: 'carol@pay.test' }, { hex: bad.toHex(), reference: dest.reference }))[0]).toBe(
      400,
    );

    const [rs, rr] = await h.receive({ handle: 'carol@pay.test' }, { hex: tx.toHex(), reference: dest.reference });
    expect(rs).toBe(200);
    expect(rr.txid).toBe(tx.id('hex'));
    expect(broadcasts).toEqual([tx.id('hex')]);
    // Idempotent re-delivery; a different tx for the same reference is refused.
    expect((await h.receive({ handle: 'carol@pay.test' }, { hex: tx.toHex(), reference: dest.reference }))[0]).toBe(
      200,
    );
    expect((await h.receive({ handle: 'carol@pay.test' }, { hex: bad.toHex(), reference: dest.reference }))[0]).toBe(
      409,
    );

    // Inbox requires the owner's signature.
    expect((await h.inbox({}, await user().sign('inbox', {})))[1].payments).toHaveLength(0);
    const [is, inbox] = await h.inbox({}, await u.sign('inbox', {}));
    expect(is).toBe(200);
    expect(inbox.payments).toHaveLength(1);
    const p = inbox.payments[0];
    expect(p.outputs[0].vout).toBe(2);

    // The wallet derives the matching key: identity priv, counterparty = anyone (BRC-29 wallet payment).
    const child = new KeyDeriver(u.priv).derivePrivateKey(
      pm.BRC29,
      `${p.outputs[0].derivationPrefix} ${p.outputs[0].derivationSuffix}`,
      inbox.senderIdentityKey,
    );
    expect(new P2PKH().lock(child.toAddress()).toHex()).toBe(dest.outputs[0].script);

    const [as, ar] = await h.ack({}, await u.sign('ack', { references: p.reference }));
    expect(as).toBe(200);
    expect(ar.collected).toBe(1);
    expect((await h.inbox({}, await u.sign('inbox', {})))[1].payments).toHaveLength(0);
  });

  test('unknown reference / unknown alias', async () => {
    const h = pm.makeHandlers({ store: memStore(), env: ENV });
    expect((await h.p2pDestination({ handle: 'nobody@pay.test' }, { satoshis: 1 }))[0]).toBe(404);
    expect((await h.receive({ handle: 'nobody@pay.test' }, { hex: '00', reference: 'x' }))[0]).toBe(404);
  });
});

describe('multiple domains', () => {
  const MULTI = {
    PAYMAIL_DOMAIN: 'b0ase.com',
    PAYMAIL_DOMAINS: ' bwallet-nine.vercel.app, B0ASE.com ,,old.test',
    PAYMAIL_BASE_URL: 'https://pay.b0ase.com/',
  };

  test('primary first, de-duplicated, lower-cased', () => {
    expect(pm.domains(MULTI)).toEqual(['b0ase.com', 'bwallet-nine.vercel.app', 'old.test']);
    expect(pm.domain(MULTI)).toBe('b0ase.com');
    expect(pm.domain({ PAYMAIL_DOMAINS: 'a.test,b.test' })).toBe('a.test');
  });

  test('capabilities use PAYMAIL_BASE_URL, not the paymail domain', () => {
    const c = pm.capabilities(MULTI).capabilities;
    for (const v of Object.values(c)) expect(v.startsWith('https://pay.b0ase.com/api/paymail/')).toBe(true);
    expect(pm.baseUrl({ PAYMAIL_DOMAIN: 'b0ase.com' })).toBe('https://b0ase.com');
  });

  test('parseHandle accepts every listed domain only', () => {
    expect(pm.parseHandle('alice@b0ase.com', MULTI)).toBe('alice');
    expect(pm.parseHandle('alice@bwallet-nine.vercel.app', MULTI)).toBe('alice');
    expect(pm.parseHandle('alice@old.test', MULTI)).toBe('alice');
    expect(pm.parseHandle('alice@pay.b0ase.com', MULTI)).toBeNull();
  });

  test('one alias resolves to the same record on every domain; register uses the primary', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: MULTI });
    const u = user();
    const [, r] = await h.register({}, await u.sign('register', { alias: 'alice' }));
    expect(r.paymail).toBe('alice@b0ase.com');
    for (const d of ['b0ase.com', 'bwallet-nine.vercel.app', 'old.test']) {
      const [s, pki] = await h.pki({ handle: `alice@${d}` });
      expect(s).toBe(200);
      expect(pki.pubkey).toBe(u.identityKey);
      expect(pki.handle).toBe(`alice@${d}`);
      expect((await h.verify({ handle: `alice@${d}`, pubkey: u.identityKey }))[1].match).toBe(true);
    }
    expect((await h.pki({ handle: 'alice@elsewhere.test' }))[0]).toBe(404);
    expect((await h.lookup({ key: u.identityKey }))[1].paymail).toBe('alice@b0ase.com');
  });

  test('aliases are unique across domains', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: MULTI });
    expect((await h.register({}, await user().sign('register', { alias: 'bob' })))[0]).toBe(200);
    // Same alias under an old domain's env is still the same record → taken.
    const old = pm.makeHandlers({ store, env: { PAYMAIL_DOMAIN: 'old.test', PAYMAIL_DOMAINS: 'b0ase.com' } });
    expect((await old.register({}, await user().sign('register', { alias: 'bob' })))[0]).toBe(409);
  });

  test('P2P destination works through an old domain', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: MULTI });
    await h.register({}, await user().sign('register', { alias: 'carol' }));
    const [s, out] = await h.p2pDestination({ handle: 'carol@bwallet-nine.vercel.app' }, { satoshis: 1000 });
    expect(s).toBe(200);
    expect(store.pays.get(out.reference).alias).toBe('carol');
  });
});

describe('production config: bwallet.space primary, b0ase.com legacy', () => {
  const PROD = {
    PAYMAIL_DOMAIN: 'bwallet.space',
    PAYMAIL_DOMAINS: 'b0ase.com',
    PAYMAIL_BASE_URL: 'https://pay.bwallet.space',
  };

  test('domains, base URL and capabilities', () => {
    expect(pm.domains(PROD)).toEqual(['bwallet.space', 'b0ase.com']);
    expect(pm.domain(PROD)).toBe('bwallet.space');
    expect(pm.baseUrl(PROD)).toBe('https://pay.bwallet.space');
    for (const v of Object.values(pm.capabilities(PROD).capabilities)) {
      expect(v.startsWith('https://pay.bwallet.space/api/paymail/')).toBe(true);
    }
  });

  test('new names register on bwallet.space; legacy b0ase.com addresses still resolve', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: PROD });
    const u = user();
    const [, r] = await h.register({}, await u.sign('register', { alias: 'dave' }));
    expect(r.paymail).toBe('dave@bwallet.space');
    for (const d of ['bwallet.space', 'b0ase.com']) {
      const [s, pki] = await h.pki({ handle: `dave@${d}` });
      expect(s).toBe(200);
      expect(pki.handle).toBe(`dave@${d}`);
    }
    expect(pm.parseHandle('dave@pay.bwallet.space', PROD)).toBeNull();
    expect((await h.lookup({ key: u.identityKey }))[1].paymail).toBe('dave@bwallet.space');
  });

  test('a name claimed under b0ase.com stays the same record on bwallet.space', async () => {
    const store = memStore();
    const old = pm.makeHandlers({ store, env: { PAYMAIL_DOMAIN: 'b0ase.com' } });
    const u = user();
    await old.register({}, await u.sign('register', { alias: 'erin' }));
    const h = pm.makeHandlers({ store, env: PROD });
    expect((await h.pki({ handle: 'erin@bwallet.space' }))[1].pubkey).toBe(u.identityKey);
    const [s] = await h.p2pDestination({ handle: 'erin@b0ase.com' }, { satoshis: 1000 });
    expect(s).toBe(200);
    expect((await h.register({}, await user().sign('register', { alias: 'erin' })))[0]).toBe(409);
  });
});

describe('delete (account deletion)', () => {
  test('a signed delete removes the alias and its inbox; others are untouched', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const u = user();
    const v = user();
    await h.register({}, await u.sign('register', { alias: 'gone' }));
    await h.register({}, await v.sign('register', { alias: 'stays' }));
    store.pays.set('r1', { reference: 'r1', identity_key: u.identityKey, alias: 'gone', status: 'collected' });
    expect((await h.delete({}, await u.sign('delete', { confirm: 'nope' })))[0]).toBe(400);
    const [s, r] = await h.delete({}, await u.sign('delete', { confirm: 'DELETE' }));
    expect(s).toBe(200);
    expect(r).toMatchObject({ deleted: true, alias: 'gone', aliases: 1, payments: 1 });
    expect(store.aliases.has('gone')).toBe(false);
    expect(store.aliases.has('stays')).toBe(true);
    expect((await h.pki({ handle: 'gone@pay.test' }))[0]).toBe(404);
  });

  test('refuses a delete signed by another key', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const u = user();
    const v = user();
    await h.register({}, await u.sign('register', { alias: 'mine' }));
    const forged = { ...(await v.sign('delete', { confirm: 'DELETE' })), identityKey: u.identityKey };
    expect((await h.delete({}, forged))[0]).toBe(401);
    expect(store.aliases.has('mine')).toBe(true);
  });
});
