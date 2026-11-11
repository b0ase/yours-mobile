// Names held for an X account (owner, 11 Nov 2026; lib/xHolds.js, migrations/20261111_paymail_x_holds.sql).
// The hold decides who may register a paymail name, so every path that creates a name is exercised here.
import { describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import pm from '../lib/paymail.js';
import nameFee from '../lib/nameFee.js';
import social from '../lib/social.js';
import xHolds from '../lib/xHolds.js';
import { supabaseStore } from '../lib/paymailStore.js';
import { aliasWrites } from './fixtures/aliasWrites.js';

// Test-only values (not real credentials).
const SEAL = 'ab'.repeat(32);
const ADMIN = 'test-admin-secret-0123456789';
const FEE_ADDR = PrivateKey.fromRandom().toAddress();
const ENV = { PAYMAIL_DOMAIN: 'pay.test', SOCIAL_SEAL_KEY: SEAL, PAYMAIL_ADMIN_SECRET: ADMIN };
const FENV = { ...ENV, BWALLET_NAME_FEE_ADDRESS: FEE_ADDR };
const KURT_ID = '304746564';
const DAY = 86_400_000;
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

const store = () => {
  const aliases = new Map();
  const forwards = new Map();
  const holds = new Map();
  const links = [];
  const s = {
    aliases,
    forwards,
    holds,
    links,
    getAlias: async (a) => aliases.get(a) ?? null,
    getAliasByKey: async (k) => [...aliases.values()].find((r) => r.identity_key === k) ?? null,
    getAliasByKeyKind: async (k, kind) =>
      [...aliases.values()].find(
        (r) => r.identity_key === k && (r.kind ?? 'plain') === kind && r.is_primary !== false,
      ) ?? null,
    listByKey: async (k) => [...aliases.values()].filter((r) => r.identity_key === k),
    insertExtraAlias: async (r) => {
      if (aliases.has(r.alias)) throw new Error('supabase 409');
      const row = { ...r, kind: 'plain', is_primary: false };
      aliases.set(r.alias, row);
      return row;
    },
    getForward: async (a) => forwards.get(a) ?? null,
    deleteForward: async (a) => void forwards.delete(a),
    ...aliasWrites(aliases, { forwards }),
    listSocialLinks: async (k) => links.filter((l) => l.identity_key === k),
    getXHold: async (a) => holds.get(a) ?? null,
    listXHolds: async () => [...holds.values()].filter((r) => !r.released_at),
    insertXHold: async (r) => {
      if (holds.has(r.alias)) {
        const e = new Error('supabase 409');
        e.status = 409;
        throw e;
      }
      const row = { released_at: null, claimed_at: null, claimed_key: null, ...r };
      holds.set(r.alias, row);
      return row;
    },
    releaseXHold: async (a, at) => {
      const h = holds.get(a);
      if (!h || h.released_at || h.claimed_at) return null;
      h.released_at = at;
      return h;
    },
    markXHoldClaimed: async (a, key, at) => {
      const h = holds.get(a);
      if (h && !h.claimed_at) Object.assign(h, { claimed_at: at, claimed_key: key });
    },
    fees: new Set(),
    receipts: [],
    useFeeTx: async (r) => (s.fees.has(r.txid) ? false : (s.fees.add(r.txid), s.receipts.push(r), true)),
  };
  return s;
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
  return { identityKey, sign };
};

/** A verified X link on this key for this X id, as lib/socialLinks.js stores it. */
const linkX = (s, u, xId, handle = 'someone') =>
  s.links.push({ provider: 'x', account: sha(`x:${xId}`), handle, identity_key: u.identityKey });
/** A Continue with X ticket + the secret that opens it. */
/** A Continue with X ticket + its secret; `pk` = the wallet key it was started for (proof_key), if any. */
const xTicket = (id, name = 'kurtwuckertjr', secret = 'device-secret-1', e = Date.now() + 60_000, pk = undefined) => ({
  ticket: social.seal({ p: 'x', id, name, vh: social.sha256Hex(secret), e, ...(pk ? { pk } : {}) }, ENV),
  secret,
});

const holdKurt = async (h, extra = {}) =>
  h['x-hold-put'](
    {},
    { alias: 'kurt', x_user_id: KURT_ID, x_handle: 'kurtwuckertjr', ...extra },
    { adminSecret: ADMIN },
  );

describe('x-hold-put (admin)', () => {
  test('needs the admin secret; never with it unset', async () => {
    const s = store();
    const put = pm.makeHandlers({ store: s, env: ENV })['x-hold-put'];
    expect((await put({}, { alias: 'kurt', x_user_id: KURT_ID }, {}))[0]).toBe(401);
    expect((await put({}, { alias: 'kurt', x_user_id: KURT_ID }, { adminSecret: 'wrong' }))[0]).toBe(401);
    const noSecret = pm.makeHandlers({ store: s, env: { ...ENV, PAYMAIL_ADMIN_SECRET: '' } });
    expect((await noSecret['x-hold-put']({}, { alias: 'kurt', x_user_id: KURT_ID }, { adminSecret: '' }))[0]).toBe(401);
    expect(s.holds.size).toBe(0);
  });

  test('holds a free plain name by the numeric X id, 90 days by default', async () => {
    const s = store();
    const h = pm.makeHandlers({ store: s, env: ENV });
    const [st, out] = await holdKurt(h);
    expect(st).toBe(200);
    expect(out.hold).toMatchObject({ alias: 'kurt', status: 'held', xHandle: 'kurtwuckertjr', xUserId: KURT_ID });
    const row = s.holds.get('kurt');
    expect(row.x_user_id).toBe(KURT_ID);
    expect(Math.round((Date.parse(row.expires_at) - Date.now()) / DAY)).toBe(90);
  });

  test('refuses a bad id, a @name for an id, reserved / dotted names, taken names and a second hold', async () => {
    const s = store();
    const h = pm.makeHandlers({ store: s, env: ENV });
    const put = (b) => h['x-hold-put']({}, b, { adminSecret: ADMIN });
    expect((await put({ alias: 'kurt', x_user_id: 'kurtwuckertjr' }))[0]).toBe(400);
    expect((await put({ alias: 'kurt', x_user_id: '' }))[0]).toBe(400);
    expect((await put({ alias: 'kurt.x', x_user_id: KURT_ID }))[0]).toBe(400);
    expect((await put({ alias: 'bcorp', x_user_id: KURT_ID }))[0]).toBe(400);
    expect((await put({ alias: 'kurt', x_user_id: KURT_ID, days: 9999 }))[0]).toBe(400);
    await s.insertAlias({ kind: 'plain', alias: 'alice', identity_key: user().identityKey });
    expect((await put({ alias: 'alice', x_user_id: KURT_ID }))[0]).toBe(409);
    s.forwards.set('oldie', {
      from_alias: 'oldie',
      to_alias: 'alice',
      identity_key: 'x',
      expires_at: new Date(Date.now() + DAY).toISOString(),
    });
    expect((await put({ alias: 'oldie', x_user_id: KURT_ID }))[0]).toBe(409);
    expect((await holdKurt(h))[0]).toBe(200);
    expect((await put({ alias: 'kurt', x_user_id: '12345' }))[0]).toBe(409);
    expect(s.holds.get('kurt').x_user_id).toBe(KURT_ID);
  });
});

describe('register under a hold', () => {
  test('a reserved alias is refused to everyone else, with a plain message', async () => {
    const s = store();
    const h = pm.makeHandlers({ store: s, env: ENV });
    await holdKurt(h);
    const [st, out] = await h.register({}, await user().sign('register', { alias: 'kurt' }));
    expect(st).toBe(403);
    expect(out.reason).toBe('x-hold');
    expect(out.error).toContain('held for @kurtwuckertjr');
    expect(s.aliases.has('kurt')).toBe(false);
  });

  test('a different X account (linked, or by ticket) is refused, even with the same @name', async () => {
    const s = store();
    const h = pm.makeHandlers({ store: s, env: ENV });
    await holdKurt(h);
    const imposter = user();
    // Somebody who now holds the @name kurtwuckertjr on X, but is a different X account (id).
    linkX(s, imposter, '999999', 'kurtwuckertjr');
    const body = {
      ...(await imposter.sign('register', { alias: 'kurt' })),
      social: xTicket('999999', 'kurtwuckertjr', undefined, undefined, imposter.identityKey),
    };
    expect((await h.register({}, body))[0]).toBe(403);
    expect(s.aliases.has('kurt')).toBe(false);
  });

  test("another wallet's X link does not count, nor a ticket that won't open", async () => {
    const s = store();
    const h = pm.makeHandlers({ store: s, env: ENV });
    await holdKurt(h);
    const kurt = user();
    const other = user();
    linkX(s, kurt, KURT_ID);
    expect((await h.register({}, await other.sign('register', { alias: 'kurt' })))[0]).toBe(403);
    const t = xTicket(KURT_ID, undefined, undefined, undefined, other.identityKey);
    const wrongSecret = {
      ...(await other.sign('register', { alias: 'kurt' })),
      social: { ticket: t.ticket, secret: 'guess' },
    };
    expect((await h.register({}, wrongSecret))[0]).toBe(403);
    const expired = {
      ...(await other.sign('register', { alias: 'kurt' })),
      social: xTicket(KURT_ID, 'k', 's', Date.now() - 1, other.identityKey),
    };
    expect((await h.register({}, expired))[0]).toBe(403);
    expect(s.aliases.has('kurt')).toBe(false);
  });

  test('the matching X id claims it by a verified X link, free even though 4 letters cost $10', async () => {
    const s = store();
    const h = pm.makeHandlers({ store: s, env: FENV, feeChain: { tx: async () => null, bsvUsd: async () => 50 } });
    await holdKurt(h);
    const kurt = user();
    // Any other 4-letter name still needs its $10 here; the holder gets the held one free.
    expect((await h.register({}, await user().sign('register', { alias: 'abcd' })))[0]).toBe(402);
    linkX(s, kurt, KURT_ID, 'kurtwuckertjr');
    const [st, out] = await h.register({}, await kurt.sign('register', { alias: 'kurt' }));
    expect(st).toBe(200);
    expect(out.paymail).toBe('kurt@pay.test');
    expect(s.receipts).toEqual([]);
    expect(s.holds.get('kurt')).toMatchObject({ claimed_key: kurt.identityKey });
    expect(s.holds.get('kurt').claimed_at).toBeTruthy();
  });

  test('the matching X id claims it with a fresh Continue with X ticket', async () => {
    const s = store();
    const h = pm.makeHandlers({ store: s, env: ENV });
    await holdKurt(h);
    const kurt = user();
    const body = {
      ...(await kurt.sign('register', { alias: 'kurt' })),
      social: xTicket(KURT_ID, 'whatever-name-now', undefined, undefined, kurt.identityKey),
    };
    expect((await h.register({}, body))[0]).toBe(200);
    expect(s.aliases.get('kurt').identity_key).toBe(kurt.identityKey);
  });

  test("a ticket is bound to one wallet: a copied ticket, or one with no proof_key, can't claim the name", async () => {
    const s = store();
    const h = pm.makeHandlers({ store: s, env: ENV });
    await holdKurt(h);
    const kurt = user();
    const thief = user();
    // Kurt's real ticket (for Kurt's key), copied with its secret by somebody else.
    const kurts = xTicket(KURT_ID, 'kurtwuckertjr', 'device-secret-1', undefined, kurt.identityKey);
    expect((await h.register({}, { ...(await thief.sign('register', { alias: 'kurt' })), social: kurts }))[0]).toBe(
      403,
    );
    // A ticket with no key in it (an older client) proves nothing for a held name, even for the right wallet.
    const bare = xTicket(KURT_ID);
    expect((await h.register({}, { ...(await kurt.sign('register', { alias: 'kurt' })), social: bare }))[0]).toBe(403);
    expect(s.aliases.has('kurt')).toBe(false);
    // The X sign-in carries the wallet key into the ticket (start → state → ticket → openTicket).
    const [st, out] = social.start(
      { provider: 'x', verifier_hash: social.sha256Hex('v'), proof_key: kurt.identityKey },
      { ...ENV, X_CLIENT_ID: 'id', X_CLIENT_SECRET: 'secret' },
    );
    expect(st).toBe(200);
    const state = social.open(new URL(out.authorizeUrl).searchParams.get('state'), ENV);
    expect(state.pk).toBe(kurt.identityKey);
  });

  test('double claim: a second wallet, even one proving the same X account, is refused; the first claim stands', async () => {
    const s = store();
    const h = pm.makeHandlers({ store: s, env: ENV });
    await holdKurt(h);
    const a = user();
    const b = user();
    linkX(s, a, KURT_ID);
    expect((await h.register({}, await a.sign('register', { alias: 'kurt' })))[0]).toBe(200);
    const body = {
      ...(await b.sign('register', { alias: 'kurt' })),
      social: xTicket(KURT_ID, undefined, undefined, undefined, b.identityKey),
    };
    expect((await h.register({}, body))[0]).toBe(409);
    expect(s.aliases.get('kurt').identity_key).toBe(a.identityKey);
    expect(s.holds.get('kurt').claimed_key).toBe(a.identityKey);
    // The holder updating their own name's profile needs no proof again.
    s.links.length = 0;
    expect((await h.register({}, await a.sign('register', { alias: 'kurt', name: 'Kurt' })))[0]).toBe(200);
  });

  test('expiry: an unclaimed hold that ran out lets the name follow the normal rules', async () => {
    const s = store();
    const h = pm.makeHandlers({ store: s, env: ENV });
    await holdKurt(h);
    s.holds.get('kurt').expires_at = new Date(Date.now() - 1000).toISOString();
    expect((await h['x-hold']({ alias: 'kurt' }))[1].status).toBe('expired');
    expect((await h.register({}, await user().sign('register', { alias: 'kurt' })))[0]).toBe(200);
  });

  test('released holds stop protecting; a claimed hold keeps protecting the name for that X account', async () => {
    const s = store();
    const h = pm.makeHandlers({ store: s, env: ENV });
    await holdKurt(h);
    expect((await h['x-hold-release']({}, { alias: 'kurt' }, {}))[0]).toBe(401);
    expect((await h['x-hold-release']({}, { alias: 'kurt' }, { adminSecret: ADMIN }))[0]).toBe(200);
    expect((await h['x-hold']({ alias: 'kurt' }))[1].status).toBe('none');
    expect((await h.register({}, await user().sign('register', { alias: 'kurt' })))[0]).toBe(200);

    const s2 = store();
    const h2 = pm.makeHandlers({ store: s2, env: ENV });
    await holdKurt(h2);
    const kurt = user();
    linkX(s2, kurt, KURT_ID);
    expect((await h2.register({}, await kurt.sign('register', { alias: 'kurt' })))[0]).toBe(200);
    expect((await h2['x-hold-release']({}, { alias: 'kurt' }, { adminSecret: ADMIN }))[0]).toBe(404);
    // Even if the name is later let go, past its old expiry, only that X account can take it back.
    s2.aliases.delete('kurt');
    s2.holds.get('kurt').expires_at = new Date(Date.now() - DAY).toISOString();
    expect((await h2.register({}, await user().sign('register', { alias: 'kurt' })))[0]).toBe(403);
  });

  test('a rename onto a held name needs the same proof', async () => {
    const s = store();
    const h = pm.makeHandlers({ store: s, env: ENV });
    await holdKurt(h);
    const u = user();
    expect((await h.register({}, await u.sign('register', { alias: 'firstname' })))[0]).toBe(200);
    expect((await h.register({}, await u.sign('register', { alias: 'kurt' }, Date.now() + 1)))[0]).toBe(403);
    expect(s.aliases.has('firstname')).toBe(true);
  });

  test('a hold read that fails closes the door (register errors, never hands the name out)', async () => {
    const s = store();
    s.getXHold = async () => {
      throw new Error('supabase 500');
    };
    const h = pm.makeHandlers({ store: s, env: ENV });
    await expect(h.register({}, await user().sign('register', { alias: 'kurt' }))).rejects.toThrow();
    expect(s.aliases.has('kurt')).toBe(false);
  });
});

describe('names-add under a hold', () => {
  test('refused to others; allowed for the matching X id; recorded once', async () => {
    const s = store();
    const h = pm.makeHandlers({ store: s, env: ENV });
    await holdKurt(h);
    const other = user();
    expect((await h.register({}, await other.sign('register', { alias: 'othername' })))[0]).toBe(200);
    const [st, out] = await h['names-add']({}, await other.sign('names-add', { alias: 'kurt' }));
    expect(st).toBe(403);
    expect(out.error).toContain('@kurtwuckertjr');
    const kurt = user();
    expect((await h.register({}, await kurt.sign('register', { alias: 'kurtsmain' })))[0]).toBe(200);
    linkX(s, kurt, KURT_ID);
    expect((await h['names-add']({}, await kurt.sign('names-add', { alias: 'kurt' })))[0]).toBe(200);
    expect(s.holds.get('kurt').claimed_key).toBe(kurt.identityKey);
    // Double claim through names-add: taken.
    linkX(s, other, KURT_ID);
    expect((await h['names-add']({}, await other.sign('names-add', { alias: 'kurt' }, Date.now() + 1)))[0]).toBe(409);
  });
});

describe('available + x-hold (read)', () => {
  test('held to everyone, free (price 0) to the key with that X account linked', async () => {
    const s = store();
    const h = pm.makeHandlers({ store: s, env: FENV });
    await holdKurt(h);
    const anon = (await h.available({ alias: 'kurt' }))[1];
    expect(anon).toMatchObject({ status: 'held-x', available: false, reason: 'reserved', xHandle: 'kurtwuckertjr' });
    const kurt = user();
    expect((await h.available({ alias: 'kurt', key: kurt.identityKey }))[1].available).toBe(false);
    linkX(s, kurt, KURT_ID);
    expect((await h.available({ alias: 'kurt', key: kurt.identityKey }))[1]).toMatchObject({
      status: 'free',
      available: true,
      priceUsd: 0,
    });
  });

  test('x-hold never shows the X id or the claiming key', async () => {
    const s = store();
    const h = pm.makeHandlers({ store: s, env: ENV });
    expect((await h['x-hold']({ alias: 'kurt' }))[1]).toEqual({ alias: 'kurt', status: 'none' });
    await holdKurt(h);
    const held = (await h['x-hold']({ alias: 'kurt' }))[1];
    expect(held).toMatchObject({ alias: 'kurt', status: 'held', xHandle: 'kurtwuckertjr' });
    const kurt = user();
    linkX(s, kurt, KURT_ID);
    await h.register({}, await kurt.sign('register', { alias: 'kurt' }));
    const claimed = (await h['x-hold']({ alias: 'kurt' }))[1];
    expect(claimed.status).toBe('claimed');
    for (const o of [held, claimed]) {
      expect(JSON.stringify(o)).not.toContain(KURT_ID);
      expect(JSON.stringify(o)).not.toContain(kurt.identityKey);
    }
    expect((await h['x-hold']({ alias: 'Bad Name' }))[0]).toBe(400);
  });

  test('a store with no holds (before the migration) changes nothing', async () => {
    const s = store();
    delete s.getXHold;
    const h = pm.makeHandlers({ store: s, env: ENV });
    expect((await h.register({}, await user().sign('register', { alias: 'kurt' })))[0]).toBe(200);
  });
});

describe('near variants (security review, 11 Nov 2026)', () => {
  test('names that read as a held one are refused to others; the holder may take them (normal price)', async () => {
    const s = store();
    const h = pm.makeHandlers({ store: s, env: ENV });
    await holdKurt(h);
    for (const alias of ['kurtt', 'kurtjr', 'kurtw', 'kurt0', 'kurt-1', 'ku-rt', 'kuurt', 'thekurt', 'kurt99']) {
      const [st, out] = await h.register({}, await user().sign('register', { alias }));
      expect([alias, st]).toEqual([alias, 403]);
      expect(out.error).toContain('too close to a name held for @kurtwuckertjr');
      expect((await h.available({ alias }))[1].status).toBe('held-x');
    }
    // Not near: different names that merely share letters.
    for (const alias of ['curt', 'hurt', 'burt', 'kurtwuckertjr'])
      expect([alias, (await h.register({}, await user().sign('register', { alias })))[0]]).toEqual([alias, 200]);
    const kurt = user();
    linkX(s, kurt, KURT_ID);
    expect((await h.register({}, await kurt.sign('register', { alias: 'kurtjr' })))[0]).toBe(200);
    // A near variant never marks the hold claimed.
    expect(s.holds.get('kurt').claimed_at).toBeNull();
    // names-add takes the same rule.
    const other = user();
    expect((await h.register({}, await other.sign('register', { alias: 'otherone' })))[0]).toBe(200);
    expect((await h['names-add']({}, await other.sign('names-add', { alias: 'kurtw' })))[0]).toBe(403);
  });

  test('released or expired holds stop guarding their variants', async () => {
    const s = store();
    const h = pm.makeHandlers({ store: s, env: ENV });
    await holdKurt(h);
    s.holds.get('kurt').expires_at = new Date(Date.now() - 1).toISOString();
    expect((await h.register({}, await user().sign('register', { alias: 'kurtt' })))[0]).toBe(200);
  });
});

describe('the claimed-mark (security review, 11 Nov 2026)', () => {
  test('a failed mark is retried; a hold never expires while its name has a row; the mark is put back', async () => {
    const s = store();
    const h = pm.makeHandlers({ store: s, env: ENV });
    await holdKurt(h);
    const kurt = user();
    linkX(s, kurt, KURT_ID);
    let fails = 3; // every attempt in the register call fails
    const mark = s.markXHoldClaimed;
    s.markXHoldClaimed = async (...a) => {
      if (fails-- > 0) throw new Error('supabase 500');
      return mark(...a);
    };
    const errs = [];
    const orig = console.error;
    console.error = (...a) => errs.push(a.join(' '));
    try {
      expect((await h.register({}, await kurt.sign('register', { alias: 'kurt' })))[0]).toBe(200);
    } finally {
      console.error = orig;
    }
    expect(errs.filter((e) => e.includes('x-hold claimed-mark failed')).length).toBe(3);
    expect(s.holds.get('kurt').claimed_at).toBeNull();
    // Past its expiry, the hold stays live while kurt@ has a row, and the next read re-marks it from that row.
    s.holds.get('kurt').expires_at = new Date(Date.now() - DAY).toISOString();
    const read = (await h['x-hold']({ alias: 'kurt' }))[1];
    expect(read.status).toBe('claimed');
    expect(s.holds.get('kurt').claimed_key).toBe(kurt.identityKey);
    // So when the name is later let go, only that X account can take it back.
    s.aliases.delete('kurt');
    expect((await h.register({}, await user().sign('register', { alias: 'kurt' })))[0]).toBe(403);
  });

  test("a row whose key doesn't prove the hold is never recorded as the claim", async () => {
    const s = store();
    const h = pm.makeHandlers({ store: s, env: ENV });
    await holdKurt(h);
    // e.g. the hold lapsed and somebody else took the name legitimately.
    s.holds.get('kurt').expires_at = new Date(Date.now() - DAY).toISOString();
    const other = user();
    expect((await h.register({}, await other.sign('register', { alias: 'kurt' })))[0]).toBe(200);
    expect((await h['x-hold']({ alias: 'kurt' }))[1].status).toBe('taken');
    expect(s.holds.get('kurt').claimed_at).toBeNull();
    // Its owner still updates it freely.
    expect((await h.register({}, await other.sign('register', { alias: 'kurt', name: 'Other' })))[0]).toBe(200);
  });
});

describe('store: only "no such table" means no holds (security review, 11 Nov 2026)', () => {
  const answer = (status, body) => async () => new Response(body, { status });
  const sEnv = { SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'test-key-not-real' };
  test('PGRST205 / 42P01: no hold; a bare 404 or any other error throws (fail closed)', async () => {
    const missing = JSON.stringify({ code: 'PGRST205', message: 'Could not find the table' });
    expect(await supabaseStore(sEnv, answer(404, missing)).getXHold('kurt')).toBeNull();
    expect(await supabaseStore(sEnv, answer(404, JSON.stringify({ code: '42P01' }))).listXHolds()).toEqual([]);
    await expect(supabaseStore(sEnv, answer(404, '<html>Not Found</html>')).getXHold('kurt')).rejects.toThrow();
    await expect(
      supabaseStore(sEnv, answer(404, JSON.stringify({ code: 'PGRST116' }))).getXHold('kurt'),
    ).rejects.toThrow();
    await expect(supabaseStore(sEnv, answer(500, missing.replace('PGRST205', 'XX000'))).listXHolds()).rejects.toThrow();
  });
});

describe('pure rules', () => {
  test('holdActive, holdRow and the link hash match lib/socialLinks.js', () => {
    expect(xHolds.holdActive(null)).toBe(false);
    expect(xHolds.holdActive({ x_user_id: '1', expires_at: null })).toBe(true);
    expect(xHolds.holdActive({ x_user_id: '1', expires_at: new Date(Date.now() - 1).toISOString() })).toBe(false);
    expect(xHolds.holdActive({ x_user_id: '1', released_at: '2026-01-01' })).toBe(false);
    expect(xHolds.holdActive({ x_user_id: 'kurt', expires_at: null })).toBe(false);
    expect(xHolds.xAccountHash(KURT_ID)).toBe(sha(`x:${KURT_ID}`));
    const { row } = xHolds.holdRow(
      { alias: ' Kurt ', x_user_id: KURT_ID, x_handle: '@KurtWuckertJr', days: 0 },
      { validAlias: pm.validAlias },
    );
    expect(row).toMatchObject({ alias: 'kurt', x_user_id: KURT_ID, x_handle: 'kurtwuckertjr', expires_at: null });
  });

  // Keeps the fee test above honest: `kurt` really is a priced length.
  test('kurt is a 4-letter (priced) name', () => expect(nameFee.namePriceUsd('kurt')).toBe(10));
});
