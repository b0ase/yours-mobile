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

  // A fake PostgREST for deleteAlias: `owned` = the row is KEY's; `foreign` = another key's payment records exist.
  const unlinkDb = ({ owned = true, foreign = false, rowDelete = [200, [{ alias: 'n1' }]] } = {}) =>
    fake((c) => {
      if (c.method === 'GET' && c.url.includes('bwallet_paymail_aliases')) return [200, owned ? [{ alias: 'n1' }] : []];
      if (c.method === 'GET' && c.url.includes('bwallet_paymail_payments'))
        return [200, foreign ? [{ reference: 'r1' }] : []];
      if (c.method === 'DELETE' && c.url.includes('bwallet_paymail_aliases')) return rowDelete;
      return [204, undefined];
    });
  const writes = (calls) => calls.filter((c) => c.method !== 'GET').map((c) => c.url.replace(/^.*\/rest\/v1\//, ''));

  test("store.deleteAlias: checks first; only then this key's payments and row, both filtered by key", async () => {
    const ok = unlinkDb();
    expect(await storeLib.supabaseStore(DB_ENV, ok.f).deleteAlias('n1', KEY)).toBe('ok');
    expect(ok.calls.filter((c) => c.method === 'GET').map((c) => c.url)).toEqual([
      expect.stringContaining(`bwallet_paymail_aliases?alias=eq.n1&identity_key=eq.${KEY}`),
      expect.stringContaining(`bwallet_paymail_payments?alias=eq.n1&identity_key=neq.${KEY}`),
    ]);
    expect(writes(ok.calls)).toEqual([
      `bwallet_paymail_payments?alias=eq.n1&identity_key=eq.${KEY}`,
      `bwallet_paymail_aliases?alias=eq.n1&identity_key=eq.${KEY}`,
    ]);
    await expect(storeLib.supabaseStore(DB_ENV, ok.f).deleteAlias('n1')).rejects.toThrow();
  });

  test("#F-237 re-review M1: store.deleteAlias deletes NOTHING when the row isn't ours or a previous owner's payments exist", async () => {
    const gone = unlinkDb({ owned: false });
    expect(await storeLib.supabaseStore(DB_ENV, gone.f).deleteAlias('n1', KEY)).toBe('gone');
    expect(writes(gone.calls)).toEqual([]);
    const blocked = unlinkDb({ foreign: true });
    expect(await storeLib.supabaseStore(DB_ENV, blocked.f).deleteAlias('n1', KEY)).toBe('blocked');
    expect(writes(blocked.calls)).toEqual([]);
    // A row that moved between the checks and the delete: 'gone'; an FK clash on the row delete: 'blocked'.
    const raced = unlinkDb({ rowDelete: [200, []] });
    expect(await storeLib.supabaseStore(DB_ENV, raced.f).deleteAlias('n1', KEY)).toBe('gone');
    const fk = unlinkDb({ rowDelete: [409, { code: '23503' }] });
    expect(await storeLib.supabaseStore(DB_ENV, fk.f).deleteAlias('n1', KEY)).toBe('blocked');
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

// ---- #F-237 re-review of da48fa98 (8 Nov 2026) ----------------------------------------------------------------------
// memStore plus signed bindings and two-party handovers, with production semantics.
const namesStore = () => {
  const s = memStore();
  s.bindings = new Map();
  s.handovers = new Map();
  s.log = [];
  return Object.assign(s, {
    getBinding: async (a) => s.bindings.get(a) ?? null,
    putBinding: async (b) => void s.bindings.set(b.alias, { ...b }),
    deleteBinding: async (a, k) => {
      if (s.bindings.get(a)?.identity_key === k) s.bindings.delete(a);
    },
    deleteForeignBindings: async (a, k) => {
      if (s.bindings.has(a) && s.bindings.get(a).identity_key !== k) s.bindings.delete(a);
    },
    logName: async (r) => void s.log.push(r),
    getHandover: async (a) => s.handovers.get(a) ?? null,
    putHandover: async (r) => void s.handovers.set(r.alias, { ...r }),
    handoversFor: async (k) => [...s.handovers.values()].filter((x) => x.to_key === k),
    claimHandover: async (a, to, seq) => {
      const x = s.handovers.get(a);
      if (!x || x.to_key !== to || Number(x.seq) !== Number(seq)) return null;
      s.handovers.delete(a);
      return x;
    },
    cancelHandover: async (a, from) => {
      const x = s.handovers.get(a);
      if (!x || x.from_key !== from) return null;
      s.handovers.delete(a);
      return x;
    },
    restoreHandover: async (r) => {
      if (!s.handovers.has(r.alias)) s.handovers.set(r.alias, { ...r });
    },
    moveAlias: async (a, to, from) => {
      const r = s.aliases.get(a);
      if (!r || r.identity_key !== from) return false;
      r.identity_key = to;
      return true;
    },
  });
};

const handOver = async (h, alias, from, to, seq = 1) => {
  expect(
    (await h['handover-release']({}, await from.sign('release', { alias, to: to.identityKey, seq: String(seq) })))[0],
  ).toBe(200);
  return h['handover-accept']({}, await to.sign('bind', { alias, seq: String(seq) }));
};

describe('#F-237 re-review: leftover holds never survive a handover (H2)', () => {
  // K sends two renames; L takes both targets mid-flight; both fail, leaving K's hold on aaaaa (row still K's).
  const leftover = async () => {
    const store = namesStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const k = user();
    const l = user();
    const b = user();
    expect((await h.register({}, await k.sign('register', { alias: 'aaaaa' })))[0]).toBe(200);
    const rename = store.renameAlias;
    const both = deferred();
    let arrived = 0;
    store.renameAlias = async (from, to, key) => {
      if (++arrived === 2) {
        for (const t of ['ccccc1', 'ccccc2'])
          await store.insertAlias({ kind: 'plain', alias: t, identity_key: l.identityKey });
        both.resolve();
      }
      await both.promise;
      return rename(from, to, key);
    };
    const b1 = await k.sign('register', { alias: 'ccccc1' });
    const b2 = await k.sign('register', { alias: 'ccccc2' }, Date.now() + 1);
    const out = await Promise.all([h.register({}, b1), h.register({}, b2)]);
    expect(out.map((r) => r[0])).toEqual([409, 409]);
    store.renameAlias = rename;
    expect(store.aliases.get('aaaaa').identity_key).toBe(k.identityKey);
    return { store, h, k, l, b };
  };

  test('after the handover the new owner can rename, and the old owner has no forward from the name', async () => {
    const { store, h, k, b } = await leftover();
    expect((await handOver(h, 'aaaaa', k, b))[0]).toBe(200);
    expect(store.forwards.has('aaaaa')).toBe(false);
    const [s, r] = await h.register({}, await b.sign('register', { alias: 'bbbbb1' }));
    expect([s, r.error]).toEqual([200, undefined]);
    expect(store.forwards.get('aaaaa').identity_key).toBe(b.identityKey);
  });

  test('after the handover and an unlink by the new owner, the name is free for anyone', async () => {
    const { h, k, l, b } = await leftover();
    expect((await handOver(h, 'aaaaa', k, b))[0]).toBe(200);
    expect((await h.unlink({}, await b.sign('unlink', { alias: 'aaaaa' })))[0]).toBe(200);
    expect((await h.register({}, await l.sign('register', { alias: 'aaaaa' })))[0]).toBe(200);
    expect((await h.pki({ handle: 'aaaaa@pay.test' }))[1].pubkey).toBe(l.identityKey);
  });

  test("another key's live forward from a name whose row is ours is stale: the rename proceeds", async () => {
    const store = namesStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const k = user();
    const old = user();
    expect((await h.register({}, await k.sign('register', { alias: 'mine5' })))[0]).toBe(200);
    // A leftover from a previous owner (pre-fix handover, or a database edit), not expired.
    await store.putForward({
      from_alias: 'mine5',
      to_alias: 'elsewhere',
      identity_key: old.identityKey,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const [s, r] = await h.register({}, await k.sign('register', { alias: 'mine6' }));
    expect([s, r.error]).toEqual([200, undefined]);
    expect(store.forwards.get('mine5')).toMatchObject({ identity_key: k.identityKey, to_alias: 'mine6' });
  });
});

describe("#F-237 re-review: handovers, bindings and unlink keep other wallets' records", () => {
  test('L2: a move that FAILS puts the claimed handover back; the recipient can accept again', async () => {
    const store = namesStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const a = user();
    const b = user();
    expect((await h.register({}, await a.sign('register', { alias: 'gift1' })))[0]).toBe(200);
    expect(
      (await h['handover-release']({}, await a.sign('release', { alias: 'gift1', to: b.identityKey, seq: '1' })))[0],
    ).toBe(200);
    const move = store.moveAlias;
    store.moveAlias = async () => {
      throw new Error('supabase 503');
    };
    await expect(h['handover-accept']({}, await b.sign('bind', { alias: 'gift1', seq: '1' }))).rejects.toThrow(
      'supabase 503',
    );
    expect((await h['handovers-for']({ key: b.identityKey }))[1].handovers.length).toBe(1);
    store.moveAlias = move;
    expect(
      (await h['handover-accept']({}, await b.sign('bind', { alias: 'gift1', seq: '1' }, Date.now() + 1)))[0],
    ).toBe(200);
    expect(store.aliases.get('gift1').identity_key).toBe(b.identityKey);
  });

  test("L3: a name taken fresh drops another wallet's stale binding, so its new owner can bind it", async () => {
    const store = namesStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const prev = user();
    const next = user();
    // A binding left by a previous owner (e.g. signed before an admin move, then the name was released).
    store.bindings.set('reborn', {
      alias: 'reborn',
      identity_key: prev.identityKey,
      seq: 4,
      signature: 'ab'.repeat(32),
      signed_at: new Date().toISOString(),
    });
    expect((await h.register({}, await next.sign('register', { alias: 'reborn' })))[0]).toBe(200);
    expect(store.bindings.has('reborn')).toBe(false);
    expect((await h.bind({}, await next.sign('bind', { alias: 'reborn', seq: '1' })))[0]).toBe(200);
  });

  test("M1: unlinking a handed-over name with a previous owner's payment records deletes nothing", async () => {
    const store = namesStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const a = user();
    const b = user();
    expect((await h.register({}, await a.sign('register', { alias: 'given' })))[0]).toBe(200);
    store.pays.set('ref-a', { reference: 'ref-a', alias: 'given', identity_key: a.identityKey, status: 'collected' });
    expect((await handOver(h, 'given', a, b))[0]).toBe(200);
    store.pays.set('ref-b', { reference: 'ref-b', alias: 'given', identity_key: b.identityKey, status: 'collected' });
    const [s, r] = await h.unlink({}, await b.sign('unlink', { alias: 'given' }));
    expect(s).toBe(409);
    expect(r.error).toMatch(/previous owner/);
    // Nothing was deleted: the new owner's own history (listHistory restore) and the row are intact.
    expect(store.pays.has('ref-b')).toBe(true);
    expect(store.pays.has('ref-a')).toBe(true);
    expect(store.aliases.get('given').identity_key).toBe(b.identityKey);
  });
});

// ---- #F-237 third review of 0efc4ed3 (8 Nov 2026) -------------------------------------------------------------------
describe('#F-237 third review: no hold of the old owner survives a handover that lands mid-rename', () => {
  test('K releases aaaaa to B, then renames; B accepts mid-rename: no K forward stays, and unlink frees it', async () => {
    const store = namesStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const k = user();
    const b = user();
    const l = user();
    expect((await h.register({}, await k.sign('register', { alias: 'aaaaa' })))[0]).toBe(200);
    expect(
      (await h['handover-release']({}, await k.sign('release', { alias: 'aaaaa', to: b.identityKey, seq: '1' })))[0],
    ).toBe(200);
    const acceptBody = await b.sign('bind', { alias: 'aaaaa', seq: '1' });
    // K's rename has read its name (mine = aaaaa); B accepts before K's hold is written.
    const holdForward = store.holdForward;
    let accepted = null;
    store.holdForward = async function (r) {
      if (!accepted && r.from_alias === 'aaaaa') accepted = await h['handover-accept']({}, acceptBody);
      return holdForward.call(this, r);
    };
    const [ks] = await h.register({}, await k.sign('register', { alias: 'kkkkk2' }));
    expect(accepted[0]).toBe(200);
    expect(ks).toBe(409);
    expect(store.aliases.get('aaaaa').identity_key).toBe(b.identityKey);
    expect(store.forwards.has('aaaaa')).toBe(false);
    // B unlinks: the name is free for anyone, not quietly K's again.
    expect((await h.unlink({}, await b.sign('unlink', { alias: 'aaaaa' })))[0]).toBe(200);
    expect((await h.register({}, await l.sign('register', { alias: 'aaaaa' })))[0]).toBe(200);
  });

  test("unlink drops another key's forward from the name first, so the name is free for anyone", async () => {
    const store = namesStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const b = user();
    const k = user();
    const l = user();
    expect((await h.register({}, await b.sign('register', { alias: 'leftname1' })))[0]).toBe(200);
    // A stale forward of another key from B's live name (a leftover from before a handover).
    await store.putForward({
      from_alias: 'leftname1',
      to_alias: 'otherplace1',
      identity_key: k.identityKey,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect((await h.unlink({}, await b.sign('unlink', { alias: 'leftname1' })))[0]).toBe(200);
    expect(store.forwards.has('leftname1')).toBe(false);
    expect((await h.register({}, await l.sign('register', { alias: 'leftname1' })))[0]).toBe(200);
  });
});

describe('#F-237 third review: a handover always leaves the new owner able to bind', () => {
  test("the new owner's binding is written before the forward cleanup, and a failed cleanup doesn't fail the accept", async () => {
    const store = namesStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const a = user();
    const b = user();
    expect((await h.register({}, await a.sign('register', { alias: 'gift2' })))[0]).toBe(200);
    expect((await h.bind({}, await a.sign('bind', { alias: 'gift2', seq: '1' })))[0]).toBe(200);
    store.deleteForward = async () => {
      throw new Error('supabase 503');
    };
    const [s] = await handOver(h, 'gift2', a, b, 2);
    expect(s).toBe(200);
    expect(store.aliases.get('gift2').identity_key).toBe(b.identityKey);
    expect(store.bindings.get('gift2').identity_key).toBe(b.identityKey);
    expect((await h.bind({}, await b.sign('bind', { alias: 'gift2', seq: '3' })))[0]).toBe(200);
  });
});
