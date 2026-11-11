// Names held for an X account (owner, 11 Nov 2026; lib/xHolds.js, migrations/20261111_paymail_x_holds.sql).
// The hold decides who may register a paymail name, so every path that creates a name is exercised here.
import { describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import pm from '../lib/paymail.js';
import nameFee from '../lib/nameFee.js';
import social from '../lib/social.js';
import xHolds from '../lib/xHolds.js';
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
const xTicket = (id, name = 'kurtwuckertjr', secret = 'device-secret-1', e = Date.now() + 60_000) => ({
  ticket: social.seal({ p: 'x', id, name, vh: social.sha256Hex(secret), e }, ENV),
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
      social: xTicket('999999', 'kurtwuckertjr'),
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
    const t = xTicket(KURT_ID);
    const wrongSecret = {
      ...(await other.sign('register', { alias: 'kurt' })),
      social: { ticket: t.ticket, secret: 'guess' },
    };
    expect((await h.register({}, wrongSecret))[0]).toBe(403);
    const expired = {
      ...(await other.sign('register', { alias: 'kurt' })),
      social: xTicket(KURT_ID, 'k', 's', Date.now() - 1),
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
    const body = { ...(await kurt.sign('register', { alias: 'kurt' })), social: xTicket(KURT_ID, 'whatever-name-now') };
    expect((await h.register({}, body))[0]).toBe(200);
    expect(s.aliases.get('kurt').identity_key).toBe(kurt.identityKey);
  });

  test('double claim: a second wallet, even one proving the same X account, is refused; the first claim stands', async () => {
    const s = store();
    const h = pm.makeHandlers({ store: s, env: ENV });
    await holdKurt(h);
    const a = user();
    const b = user();
    linkX(s, a, KURT_ID);
    expect((await h.register({}, await a.sign('register', { alias: 'kurt' })))[0]).toBe(200);
    const body = { ...(await b.sign('register', { alias: 'kurt' })), social: xTicket(KURT_ID) };
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
