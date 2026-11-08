// b-Aware #F-237, independent review of d5d783f3 (8 Nov 2026). Adopted from the reviewer's repro
// (scratchpad f237-double-rename-repro.test.js): the in-memory store is theirs; the tests now assert.
// Each test here fails on d5d783f3.
import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import pm from '../lib/paymail.js';
import storeLib from '../lib/paymailStore.js';
import { aliasWrites } from './fixtures/aliasWrites.js';

const ENV = { PAYMAIL_DOMAIN: 'pay.test' };
const DB_ENV = { ...ENV, SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'test-key' };

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
    // Test seeding only: the production store has no upsert on names (b-Aware #F-237).
    upsertAlias: async (r) => (aliases.set(r.alias, { ...r }), r),
    ...aliasWrites(aliases, { pays }),
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
      for (const [key, r] of aliases)
        if (r.identity_key === k) {
          aliases.delete(key);
          a++;
        }
      for (const [ref, r] of pays)
        if (r.identity_key === k) {
          pays.delete(ref);
          p++;
        }
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

// The old name must still be this wallet's: not claimable by anyone else, and still paying the owner.
const expectHeld = async (h, store, name, owner) => {
  const [s] = await h.register({}, await user().sign('register', { alias: name }));
  expect(s).toBe(409);
  const [ps, pki] = await h.pki({ handle: `${name}@pay.test` });
  expect(ps).toBe(200);
  expect(pki.pubkey).toBe(owner.identityKey);
  expect(store.forwards.get(name)?.identity_key).toBe(owner.identityKey);
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

describe('#F-237 review: double-submitted renames never free the old name', () => {
  test('register: the same rename sent twice', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const owner = user();
    expect((await h.register({}, await owner.sign('register', { alias: 'oldname' })))[0]).toBe(200);
    const b1 = await owner.sign('register', { alias: 'newname' });
    const b2 = await owner.sign('register', { alias: 'newname' }, Date.now() + 1);
    const out = await Promise.all([h.register({}, b1), h.register({}, b2)]);
    expect(out.map((r) => r[0]).sort()).toEqual([200, 409]);
    await expectHeld(h, store, 'oldname', owner);
    expect(store.forwards.get('oldname').to_alias).toBe('newname');
  });

  test("register: two devices rename to different names (the loser sees 'gone')", async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const owner = user();
    expect((await h.register({}, await owner.sign('register', { alias: 'oldname' })))[0]).toBe(200);
    const b1 = await owner.sign('register', { alias: 'firstnew' });
    const b2 = await owner.sign('register', { alias: 'secondnew' }, Date.now() + 1);
    const out = await Promise.all([h.register({}, b1), h.register({}, b2)]);
    expect(out.map((r) => r[0]).sort()).toEqual([200, 409]);
    const winner = out[0][0] === 200 ? 'firstnew' : 'secondnew';
    expect(store.aliases.get(winner).identity_key).toBe(owner.identityKey);
    await expectHeld(h, store, 'oldname', owner);
    // The hold points at the name that won, so payments to the old name still arrive.
    expect(store.forwards.get('oldname').to_alias).toBe(winner);
  });

  test("register: one rename of a double submit hits a name just taken ('taken') while the other wins", async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const owner = user();
    const other = user();
    expect((await h.register({}, await owner.sign('register', { alias: 'oldname' })))[0]).toBe(200);
    const yHeld = deferred();
    const xDone = deferred();
    const rename = store.renameAlias;
    store.renameAlias = async (from, to, key) => {
      if (to === 'grabbed') {
        await yHeld.promise; // the other request has set (or found) the hold
        await store.insertAlias({ kind: 'plain', alias: 'grabbed', identity_key: other.identityKey });
      }
      if (to === 'winner') {
        yHeld.resolve();
        await xDone.promise; // rename only after the losing request has cleaned up
      }
      return rename(from, to, key);
    };
    const bx = await owner.sign('register', { alias: 'grabbed' });
    const by = await owner.sign('register', { alias: 'winner' }, Date.now() + 1);
    const x = h.register({}, bx).finally(() => xDone.resolve());
    const y = h.register({}, by);
    const [xs, ys] = await Promise.all([x, y]);
    expect(xs[0]).toBe(409);
    expect(xs[1].error).toMatch(/^That name was just taken/);
    expect(ys[0]).toBe(200);
    await expectHeld(h, store, 'oldname', owner);
    expect(store.forwards.get('oldname').to_alias).toBe('winner');
  });

  const twoNames = () => {
    const store = memStore();
    const owner = user();
    store.upsertAlias({ kind: 'plain', alias: 'mainname', identity_key: owner.identityKey, is_primary: true });
    store.upsertAlias({ kind: 'plain', alias: 'two', identity_key: owner.identityKey, is_primary: false });
    return { store, owner, h: pm.makeHandlers({ store, env: ENV }) };
  };

  test("names-remove: the same removal sent twice (the loser sees 'gone')", async () => {
    const { store, owner, h } = twoNames();
    const b1 = await owner.sign('names-remove', { alias: 'two' });
    const b2 = await owner.sign('names-remove', { alias: 'two' }, Date.now() + 1);
    const out = await Promise.all([h['names-remove']({}, b1), h['names-remove']({}, b2)]);
    expect(out.map((r) => r[0]).sort()).toEqual([200, 409]);
    await expectHeld(h, store, 'two', owner);
    expect(store.forwards.get('two').to_alias).toBe('mainname');
  });

  test("names-remove: one removal of a double submit fails ('taken') while the other wins", async () => {
    const { store, owner, h } = twoNames();
    const rename = store.renameAlias;
    const secondIn = deferred();
    let calls = 0;
    let reqs = [];
    store.renameAlias = async (from, to, key) => {
      calls += 1;
      if (calls === 1) {
        await secondIn.promise;
        return 'taken'; // the tombstone name clashed: this request's rename did not happen
      }
      secondIn.resolve();
      await Promise.race(reqs); // the failing request has finished, cleanup included
      return rename(from, to, key);
    };
    const b1 = await owner.sign('names-remove', { alias: 'two' });
    const b2 = await owner.sign('names-remove', { alias: 'two' }, Date.now() + 1);
    reqs = [h['names-remove']({}, b1), h['names-remove']({}, b2)];
    const out = await Promise.all(reqs);
    expect(out.map((r) => r[0]).sort()).toEqual([200, 409]);
    await expectHeld(h, store, 'two', owner);
  });
});

describe('#F-237 review: unlink, ord proof and store filters are by key', () => {
  test('unlink: a name that moved to another key after the check is not deleted', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const a = user();
    const b = user();
    expect((await h.register({}, await a.sign('register', { alias: 'leaving' })))[0]).toBe(200);
    const del = store.deleteAlias;
    store.deleteAlias = async (alias, key) => {
      store.aliases.get(alias).identity_key = b.identityKey; // handed over between the read and the delete
      return del(alias, key);
    };
    const [s, r] = await h.unlink({}, await a.sign('unlink', { alias: 'leaving' }));
    expect(s).toBe(409);
    expect(r.error).toBe('That name is not on this wallet any more');
    expect(store.aliases.get('leaving').identity_key).toBe(b.identityKey);
  });

  const fake = (respond) => {
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
  const KEY = '02' + 'a'.repeat(64);

  test('store.deleteAlias: payments and row filtered by key; 0 rows → gone; FK clash → blocked', async () => {
    const ok = fake((c) => (c.url.includes('aliases') ? [200, [{ alias: 'n1' }]] : [204, undefined]));
    expect(await storeLib.supabaseStore(DB_ENV, ok.f).deleteAlias('n1', KEY)).toBe('ok');
    expect(ok.calls.map((c) => [c.method, c.url.replace(/^.*\/rest\/v1\//, '')])).toEqual([
      ['DELETE', `bwallet_paymail_payments?alias=eq.n1&identity_key=eq.${KEY}`],
      ['DELETE', `bwallet_paymail_aliases?alias=eq.n1&identity_key=eq.${KEY}`],
    ]);
    const none = fake((c) => (c.url.includes('aliases') ? [200, []] : [204, undefined]));
    expect(await storeLib.supabaseStore(DB_ENV, none.f).deleteAlias('n1', KEY)).toBe('gone');
    const fk = fake((c) => (c.url.includes('aliases') ? [409, { code: '23503' }] : [204, undefined]));
    expect(await storeLib.supabaseStore(DB_ENV, fk.f).deleteAlias('n1', KEY)).toBe('blocked');
    await expect(storeLib.supabaseStore(DB_ENV, ok.f).deleteAlias('n1')).rejects.toThrow();
  });

  test('store.deleteBinding and store.setOrdProof are filtered by key', async () => {
    const { f, calls } = fake(() => [204, undefined]);
    const s = storeLib.supabaseStore(DB_ENV, f);
    await s.deleteBinding('n1', KEY);
    await s.setOrdProof('n1', KEY, { sig: 'x' });
    expect(calls[0].url).toContain(`bwallet_name_bindings?alias=eq.n1&identity_key=eq.${KEY}`);
    expect(calls[1].method).toBe('PATCH');
    expect(calls[1].url).toContain(`bwallet_paymail_aliases?alias=eq.n1&identity_key=eq.${KEY}`);
  });

  test('store hold forwards: insert-if-absent, repoint and delete only by key (and mark)', async () => {
    const { f, calls } = fake((c) => (c.method === 'POST' ? [201, []] : [200, []]));
    const s = storeLib.supabaseStore(DB_ENV, f);
    expect(await s.holdForward({ from_alias: 'old', to_alias: 'new', identity_key: KEY })).toBe(false);
    expect(calls[0].url).toContain('bwallet_paymail_forwards?on_conflict=from_alias');
    expect(await s.repointOwnForward('old', KEY, 'new', { onlyIfTo: 'x' })).toBe(false);
    expect(calls[1].url).toContain(`from_alias=eq.old&identity_key=eq.${KEY}&to_alias=eq.x`);
    await s.deleteOwnForward('old', KEY, { to: 'new', expiresAt: '2027-01-01T00:00:00.000123Z' });
    expect(calls[2].url).toContain(
      `from_alias=eq.old&identity_key=eq.${KEY}&to_alias=eq.new&expires_at=eq.2027-01-01T00:00:00.000123Z`,
    );
  });

  test('store handovers are consumed by one filtered DELETE', async () => {
    const { f, calls } = fake(() => [200, [{ alias: 'n1' }]]);
    const s = storeLib.supabaseStore(DB_ENV, f);
    expect(await s.claimHandover('n1', KEY, 3)).toEqual({ alias: 'n1' });
    expect(await s.cancelHandover('n1', KEY)).toEqual({ alias: 'n1' });
    expect(calls.map((c) => c.method)).toEqual(['DELETE', 'DELETE']);
    expect(calls[0].url).toContain(`bwallet_name_handovers?alias=eq.n1&to_key=eq.${KEY}&seq=eq.3`);
    expect(calls[1].url).toContain(`bwallet_name_handovers?alias=eq.n1&from_key=eq.${KEY}`);
  });
});
