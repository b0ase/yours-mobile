import { describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, ProtoWallet, Transaction, Utils } from '@bsv/sdk';
import pm from '../lib/paymail.js';
import storeLib from '../lib/paymailStore.js';

const ENV = { PAYMAIL_DOMAIN: 'pay.test', SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'test-key' };

/** A fake PostgREST: records every call; `fail` decides which ones answer an error status. */
const fakeFetch = (respond = () => [200, []]) => {
  const calls = [];
  const f = async (url, init = {}) => {
    const call = { url: decodeURIComponent(String(url)), method: init.method || 'GET', body: init.body };
    calls.push(call);
    const [status, json] = respond(call);
    return {
      ok: status < 300,
      status,
      text: async () => (json === undefined ? '' : JSON.stringify(json)),
      headers: { get: () => null },
    };
  };
  return { f, calls };
};

describe('paymailStore: primary names', () => {
  test('getAliasByKey and getAliasByKeyKind read only the primary', async () => {
    const { f, calls } = fakeFetch(() => [200, []]);
    const s = storeLib.supabaseStore(ENV, f);
    await s.getAliasByKey('02ab');
    await s.getAliasByKeyKind('02ab', 'x');
    expect(calls.length).toBe(3);
    for (const c of calls) expect(c.url).toContain('is_primary=is.true');
  });

  test('insertExtraAlias inserts a non-primary plain name with a plain POST (no merge)', async () => {
    const { f, calls } = fakeFetch(() => [201, [{ alias: 'two' }]]);
    const s = storeLib.supabaseStore(ENV, f);
    await s.insertExtraAlias({ alias: 'two', identity_key: '02ab', kind: 'x', is_primary: true });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).not.toContain('on_conflict');
    const body = JSON.parse(calls[0].body);
    expect(body.is_primary).toBe(false);
    expect(body.kind).toBe('plain');
  });

  test('setPrimary clears the old primary before setting the new one', async () => {
    const { f, calls } = fakeFetch(() => [204, undefined]);
    await storeLib.supabaseStore(ENV, f).setPrimary('02ab', 'one', 'two');
    expect(calls.map((c) => [c.url.match(/alias=eq\.([a-z]+)/)[1], JSON.parse(c.body).is_primary])).toEqual([
      ['one', false],
      ['two', true],
    ]);
    for (const c of calls) expect(c.method).toBe('PATCH');
  });

  test('setPrimary puts the old primary back when setting the new one fails', async () => {
    const { f, calls } = fakeFetch((c) => (c.url.includes('alias=eq.two') ? [500, {}] : [204, undefined]));
    await expect(storeLib.supabaseStore(ENV, f).setPrimary('02ab', 'one', 'two')).rejects.toThrow('supabase 500');
    expect(calls.map((c) => [c.url.match(/alias=eq\.([a-z]+)/)[1], JSON.parse(c.body).is_primary])).toEqual([
      ['one', false],
      ['two', true],
      ['one', true],
    ]);
  });

  test('setPrimary stops before touching the new name when clearing the old one fails', async () => {
    const { f, calls } = fakeFetch(() => [500, {}]);
    await expect(storeLib.supabaseStore(ENV, f).setPrimary('02ab', 'one', 'two')).rejects.toThrow();
    expect(calls.length).toBe(1);
  });
});

// In-memory store with is_primary, shaped like supabaseStore. Any DELETE of an alias fails the test.
const memStore = () => {
  const aliases = new Map();
  const forwards = new Map();
  const ops = [];
  const prim = (k, kind) =>
    [...aliases.values()].find((r) => r.identity_key === k && r.kind === kind && r.is_primary) ?? null;
  return {
    aliases,
    forwards,
    ops,
    getAlias: async (a) => aliases.get(a) ?? null,
    getAliasByKey: async (k) =>
      prim(k, 'plain') ?? [...aliases.values()].find((r) => r.identity_key === k && r.is_primary) ?? null,
    getAliasByKeyKind: async (k, kind) => prim(k, kind),
    listByKey: async (k) => [...aliases.values()].filter((r) => r.identity_key === k && !r.alias.startsWith('rm-')),
    insertExtraAlias: async (r) => {
      ops.push('insert');
      if (aliases.has(r.alias)) throw new Error('supabase 409');
      const row = { ...r, kind: 'plain', is_primary: false };
      aliases.set(r.alias, row);
      return row;
    },
    setPrimary: async (k, from, to) => {
      ops.push(`clear:${from}`, `set:${to}`);
      if (from) aliases.get(from).is_primary = false;
      aliases.get(to).is_primary = true;
    },
    renameAlias: async (from, to) => {
      ops.push(`rename:${from}`);
      const r = aliases.get(from);
      aliases.delete(from);
      aliases.set(to, { ...r, alias: to });
    },
    deleteAlias: async () => {
      throw new Error('remove must never delete an alias');
    },
    getForward: async (a) => forwards.get(a) ?? null,
    putForward: async (r) => {
      ops.push(`forward:${r.from_alias}`);
      forwards.set(r.from_alias, { ...r });
    },
    deleteForward: async (a) => void forwards.delete(a),
    retargetForwards: async (from, to) => {
      for (const r of forwards.values()) if (r.to_alias === from) r.to_alias = to;
    },
  };
};

const user = () => {
  const priv = PrivateKey.fromRandom();
  const wallet = new ProtoWallet(priv);
  const identityKey = priv.toPublicKey().toString();
  const sign = async (action, fields) => {
    const timestamp = Date.now();
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

const setup = () => {
  const store = memStore();
  const h = pm.makeHandlers({ store, env: { PAYMAIL_DOMAIN: 'pay.test', NODE_ENV: 'test' } });
  const u = user();
  store.aliases.set('one', { alias: 'one', identity_key: u.identityKey, kind: 'plain', is_primary: true });
  return { store, h, u };
};

describe('several names per wallet', () => {
  test('add an extra name: non-primary, receives for the same key, main unchanged', async () => {
    const { store, h, u } = setup();
    const [s, out] = await h['names-add']({}, await u.sign('names-add', { alias: 'two' }));
    expect(s).toBe(200);
    expect(out.added).toBe('two@pay.test');
    expect(store.aliases.get('two').is_primary).toBe(false);
    const [, pki] = await h.pki({ handle: 'two@pay.test' });
    expect(pki.pubkey).toBe(u.identityKey);
    const [, look] = await h.lookup({ key: u.identityKey });
    expect(look.paymail).toBe('one@pay.test');
    expect(look.names.map((n) => [n.paymail, n.main])).toEqual([
      ['one@pay.test', true],
      ['two@pay.test', false],
    ]);
  });

  test('add refuses taken, held, social, invalid and unsigned names', async () => {
    const { store, h, u } = setup();
    store.aliases.set('bob', { alias: 'bob', identity_key: '02' + '1'.repeat(64), kind: 'plain', is_primary: true });
    store.forwards.set('held', { from_alias: 'held', to_alias: 'bob', identity_key: '02' + '1'.repeat(64) });
    expect((await h['names-add']({}, await u.sign('names-add', { alias: 'bob' })))[0]).toBe(409);
    expect((await h['names-add']({}, await u.sign('names-add', { alias: 'held' })))[0]).toBe(409);
    expect((await h['names-add']({}, await u.sign('names-add', { alias: 'me.x' })))[0]).toBe(400);
    expect((await h['names-add']({}, await u.sign('names-add', { alias: '-bad' })))[0]).toBe(400);
    expect((await h['names-add']({}, await u.sign('names-add', { alias: `rm-${'a'.repeat(28)}` })))[0]).toBe(400);
    const signed = await u.sign('names-add', { alias: 'other' });
    expect((await h['names-add']({}, { ...signed, fields: { alias: 'changed' } }))[0]).toBe(401);
  });

  test('add needs a main plain name first', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: { PAYMAIL_DOMAIN: 'pay.test', NODE_ENV: 'test' } });
    const u = user();
    expect((await h['names-add']({}, await u.sign('names-add', { alias: 'two' })))[0]).toBe(409);
  });

  test('set primary clears the old one then sets the new one', async () => {
    const { store, h, u } = setup();
    await h['names-add']({}, await u.sign('names-add', { alias: 'two' }));
    const [s, out] = await h['names-primary']({}, await u.sign('names-primary', { alias: 'two' }));
    expect(s).toBe(200);
    expect(out.main).toBe('two@pay.test');
    expect(store.ops.slice(-2)).toEqual(['clear:one', 'set:two']);
    expect((await h.lookup({ key: u.identityKey }))[1].paymail).toBe('two@pay.test');
  });

  test("set primary refuses another wallet's name", async () => {
    const { store, h, u } = setup();
    store.aliases.set('bob', { alias: 'bob', identity_key: '02' + '1'.repeat(64), kind: 'plain', is_primary: true });
    expect((await h['names-primary']({}, await u.sign('names-primary', { alias: 'bob' })))[0]).toBe(404);
  });

  test('remove never deletes: forwards to the main name (hold), then tombstones the row', async () => {
    const { store, h, u } = setup();
    await h['names-add']({}, await u.sign('names-add', { alias: 'two' }));
    const [s, out] = await h['names-remove']({}, await u.sign('names-remove', { alias: 'two' }));
    expect(s).toBe(200);
    expect(out.forwardsTo).toBe('one@pay.test');
    expect(store.ops.slice(-2)).toEqual(['forward:two', 'rename:two']);
    expect(store.forwards.get('two').to_alias).toBe('one');
    expect(Date.parse(store.forwards.get('two').expires_at)).toBeGreaterThan(Date.now());
    const tomb = [...store.aliases.keys()].find((a) => a.startsWith('rm-'));
    expect(tomb).toMatch(pm.TOMB_RE);
    // Payments to the old name still reach the same key; the tombstone itself never resolves.
    expect((await h.pki({ handle: 'two@pay.test' }))[1].pubkey).toBe(u.identityKey);
    expect((await h.pki({ handle: `${tomb}@pay.test` }))[0]).toBe(404);
    expect((await h.lookup({ key: u.identityKey }))[1].names.length).toBe(1);
  });

  test('remove refuses the main name', async () => {
    const { h, u } = setup();
    expect((await h['names-remove']({}, await u.sign('names-remove', { alias: 'one' })))[0]).toBe(409);
  });

  test('names-remove on the Supabase store sends no DELETE', async () => {
    const u = user();
    const rows = {
      one: { alias: 'one', identity_key: u.identityKey, kind: 'plain', is_primary: true },
      two: { alias: 'two', identity_key: u.identityKey, kind: 'plain', is_primary: false },
    };
    const { f, calls } = fakeFetch((c) => {
      if (c.method !== 'GET') return [204, undefined];
      if (c.url.includes('bwallet_paymail_forwards')) return [200, []];
      if (c.url.includes('kind=eq.plain&is_primary=is.true')) return [200, [rows.one]];
      const m = c.url.match(/aliases\?alias=eq\.([a-z]+)/);
      return [200, m && rows[m[1]] ? [rows[m[1]]] : []];
    });
    const h = pm.makeHandlers({
      store: storeLib.supabaseStore(ENV, f),
      env: { PAYMAIL_DOMAIN: 'pay.test', NODE_ENV: 'test' },
    });
    const [s] = await h['names-remove']({}, await u.sign('names-remove', { alias: 'two' }));
    expect(s).toBe(200);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(calls.some((c) => c.method === 'PATCH' && c.url.includes('aliases?alias=eq.two'))).toBe(true);
  });
});

describe('extra name fee', () => {
  const FEE_ADDR = PrivateKey.fromRandom().toAddress();
  const payTx = (sats, to = FEE_ADDR) => {
    const tx = new Transaction();
    tx.addOutput({ lockingScript: new P2PKH().lock(to), satoshis: sats });
    return tx;
  };
  const good = payTx(20_000); // 1¢ at $50/BSV
  const low = payTx(1_000);
  const wrong = payTx(20_000, PrivateKey.fromRandom().toAddress());
  const chain = {
    tx: async (id) => [good, low, wrong].find((t) => t.id('hex') === id) ?? null,
    bsvUsd: async () => 50,
  };
  const feeSetup = () => {
    const store = memStore();
    const used = new Set();
    store.useFeeTx = async (r) => (used.has(r.txid) ? false : (used.add(r.txid), true));
    const u = user();
    store.aliases.set('one', { alias: 'one', identity_key: u.identityKey, kind: 'plain', is_primary: true });
    const h = pm.makeHandlers({
      store,
      env: { PAYMAIL_DOMAIN: 'pay.test', NODE_ENV: 'test', BWALLET_NAME_FEE_ADDRESS: FEE_ADDR },
      feeChain: chain,
    });
    return { store, h, u };
  };

  test('refuses an unpaid, short, or wrongly addressed fee; accepts a good one once', async () => {
    const { store, h, u } = feeSetup();
    expect((await h['names-add']({}, await u.sign('names-add', { alias: 'two' })))[0]).toBe(402);
    for (const t of [low, wrong])
      expect((await h['names-add']({}, await u.sign('names-add', { alias: 'two', feeTxid: t.id('hex') })))[0]).toBe(
        402,
      );
    expect(store.aliases.has('two')).toBe(false);
    const ok = await h['names-add']({}, await u.sign('names-add', { alias: 'two', feeTxid: good.id('hex') }));
    expect(ok[0]).toBe(200);
    const again = await h['names-add']({}, await u.sign('names-add', { alias: 'three', feeTxid: good.id('hex') }));
    expect(again[0]).toBe(409);
  });
});
