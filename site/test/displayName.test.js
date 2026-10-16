import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import pm from '../lib/paymail.js';
import dn from '../lib/displayName.js';

const ENV = { PAYMAIL_DOMAIN: 'pay.test' };

const memStore = () => {
  const aliases = new Map();
  return {
    aliases,
    getAlias: async (a) => aliases.get(a) ?? null,
    getAliasByKey: async (k) =>
      [...aliases.values()].find((r) => r.identity_key === k && (r.kind ?? 'plain') === 'plain') ??
      [...aliases.values()].find((r) => r.identity_key === k) ??
      null,
    getAliasByKeyKind: async (k, kind) =>
      [...aliases.values()].find((r) => r.identity_key === k && (r.kind ?? 'plain') === kind) ?? null,
    upsertAlias: async (r) => (aliases.set(r.alias, { ...r }), r),
    setDisplayNameByKey: async (k, name) => {
      for (const r of aliases.values()) if (r.identity_key === k) r.display_name = name;
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

describe('cleanDisplayName', () => {
  test('trims, collapses spaces, keeps real names', () => {
    expect(dn.cleanDisplayName('  Mike   Smith ')).toBe('Mike Smith');
    expect(dn.cleanDisplayName('Zoë O’Brien')).toBe('Zoë O’Brien');
  });
  test('drops control and zero-width characters', () => {
    expect(dn.cleanDisplayName('Mi\u0000ke\u200b \u202eSmith\n')).toBe('Mike Smith');
  });
  test('strips impersonation: paymails, domains, verified badges', () => {
    expect(dn.cleanDisplayName('Mike @bwalletx')).toBe('Mike');
    expect(dn.cleanDisplayName('mike@bwalletx.com')).toBe('mike');
    expect(dn.cleanDisplayName('Mike (verified) ✓')).toBe('Mike');
    expect(dn.cleanDisplayName('bWalletX Official Support')).toBe('');
    expect(dn.cleanDisplayName('Mike bwalletx.com')).toBe('Mike');
  });
  test('placeholders are no name', () => {
    for (const n of ['Anonymous', 'anon', 'Account 1', '', '   ', 'bWalletX']) expect(dn.cleanDisplayName(n)).toBe('');
  });
  test('max 64 characters', () => expect(Array.from(dn.cleanDisplayName('a'.repeat(100))).length).toBe(64));
  test('default from the alias', () => {
    expect(dn.defaultDisplayName('mike')).toBe('Mike');
    expect(dn.defaultDisplayName('b0asex.x')).toBe('B0asex');
    expect(dn.defaultDisplayName('mary_jo')).toBe('Mary jo');
    expect(dn.shownDisplayName('Anonymous', 'mike')).toBe('Mike');
  });
});

describe('display name on the paymail server', () => {
  test('a claim with no name (or "Anonymous") defaults to the alias, never anonymous', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const u = user();
    expect((await h.register({}, await u.sign('register', { alias: 'mike', name: 'Anonymous' })))[0]).toBe(200);
    expect(store.aliases.get('mike').display_name).toBe('Mike');
    expect((await h.profile({ handle: 'mike@pay.test' }))[1].name).toBe('Mike');
  });

  test('an old row stored as "Anonymous" still reads as the alias', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const u = user();
    await h.register({}, await u.sign('register', { alias: 'mike' }));
    store.aliases.get('mike').display_name = 'Anonymous';
    expect((await h.profile({ handle: 'mike@pay.test' }))[1].name).toBe('Mike');
  });

  test('a typed name is kept and cleaned', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const u = user();
    await h.register({}, await u.sign('register', { alias: 'a1autos', name: ' Mike Smith @bwalletx ' }));
    expect((await h.profile({ handle: 'a1autos@pay.test' }))[1].name).toBe('Mike Smith');
  });

  test('set-name is signed, cleaned, and written to every name on the key', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const u = user();
    await h.register({}, await u.sign('register', { alias: 'a1autos' }));
    store.aliases.set('mikes', { alias: 'mikes', kind: 'x', identity_key: u.identityKey, display_name: 'Mikes' });
    const [s, r] = await h['set-name']({}, await u.sign('set-name', { name: 'Mike Smith ✓ verified' }));
    expect(s).toBe(200);
    expect(r.name).toBe('Mike Smith');
    expect(store.aliases.get('a1autos').display_name).toBe('Mike Smith');
    expect(store.aliases.get('mikes').display_name).toBe('Mike Smith');
    // A profile update without a name (a new picture) keeps it.
    await h.register({}, await u.sign('register', { alias: 'a1autos', avatar: 'https://x.test/a.png' }));
    expect((await h.profile({ handle: 'a1autos@pay.test' }))[1].name).toBe('Mike Smith');
  });

  test('set-name refuses a bad signature and a wallet with no name', async () => {
    const h = pm.makeHandlers({ store: memStore(), env: ENV });
    const u = user();
    const body = await u.sign('set-name', { name: 'Mike' });
    expect((await h['set-name']({}, { ...body, fields: { name: 'Eve' } }))[0]).toBe(401);
    expect((await h['set-name']({}, body))[0]).toBe(404);
  });

  test('blank or placeholder set-name falls back to the alias', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const u = user();
    await h.register({}, await u.sign('register', { alias: 'mike', name: 'Mike Smith' }));
    expect((await h['set-name']({}, await u.sign('set-name', { name: 'anonymous' })))[1].name).toBe('Mike');
  });

  test('a new name on a wallet inherits its display name', async () => {
    const store = memStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const u = user();
    await h.register({}, await u.sign('register', { alias: 'mike', name: 'Mike Smith' }));
    store.aliases.set('mike', { ...store.aliases.get('mike'), kind: 'x' });
    await h.register({}, await u.sign('register', { alias: 'mike2' }));
    expect(store.aliases.get('mike2').display_name).toBe('Mike Smith');
  });
});
