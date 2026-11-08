// Security triage repro (b-Aware #F-237): paymail `register` is check-then-upsert.
// register() reads the alias (getAlias), then awaits several other calls (rate limits, fee check, ...),
// then writes with upsertAlias, which in production is PostgREST `on_conflict=alias` +
// `Prefer: resolution=merge-duplicates` (site/lib/paymailStore.js upsertAlias). An upsert that lands on a row
// another wallet inserted in the meantime silently re-points that name's identity_key to the later writer.
//
// EXPECTED (secure): the second claimant gets 409 and the name stays with the wallet that was told 200.
// ACTUAL: both get 200 and the name (and every payment sent to it) now goes to the attacker's key.
import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import pm from '../lib/paymail.js';

const ENV = { PAYMAIL_DOMAIN: 'pay.test' };

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

// Minimal store with the production semantics of upsertAlias (merge-duplicates on the alias primary key).
// `gate` lets the test pause one request between its availability check and its write, standing in for the
// real awaits in that window (countIpClaims / countKeyClaims / lastRename / payForName's chain lookups).
const pgStore = () => {
  const aliases = new Map();
  let gate = null;
  return {
    aliases,
    holdNext(key) {
      let release;
      const p = new Promise((r) => (release = r));
      gate = { key, p };
      return release;
    },
    getAlias: async (a) => aliases.get(a) ?? null,
    getAliasByKey: async (k) => [...aliases.values()].find((r) => r.identity_key === k) ?? null,
    getAliasByKeyKind: async (k, kind) =>
      [...aliases.values()].find((r) => r.identity_key === k && r.kind === kind) ?? null,
    countKeyClaims: async (k) => {
      if (gate && gate.key === k) {
        const p = gate.p;
        gate = null;
        await p;
      }
      return 0;
    },
    recordNameEvent: async () => {},
    // PostgREST: INSERT ... ON CONFLICT (alias) DO UPDATE SET <every column sent>. Kept so the test fails loudly
    // if register ever goes back to it: the fixed server must not call it.
    upsertAlias: async () => {
      throw new Error('register must never upsert a name (#F-237)');
    },
    // The fixed store's writes (site/lib/paymailStore.js), with production semantics: a plain INSERT keyed by the
    // alias primary key (a clash resolves null, nothing merged), and a PATCH filtered by alias AND identity_key.
    insertAlias: async (row) => {
      if (aliases.has(row.alias)) return null;
      aliases.set(row.alias, { ...row });
      return aliases.get(row.alias);
    },
    updateOwnAlias: async (alias, key, patch) => {
      const r = aliases.get(alias);
      if (!r || r.identity_key !== key) return null;
      const { ord_address, display_name, avatar } = patch;
      return Object.assign(r, { ord_address, display_name, avatar });
    },
  };
};

describe('#F-237 paymail register race', () => {
  test('a claim that passed its check before a victim claimed the name must not overwrite the victim', async () => {
    const store = pgStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const victim = user();
    const attacker = user();

    // Attacker's request reads "alice" as free, then is held in the window before its write.
    const release = store.holdNext(attacker.identityKey);
    const attackerReq = h.register({}, await attacker.sign('register', { alias: 'alice' }));
    await new Promise((r) => setTimeout(r, 20));

    // Victim claims "alice" and is told it is theirs.
    const [vs] = await h.register({}, await victim.sign('register', { alias: 'alice' }));
    expect(vs).toBe(200);
    expect((await h.pki({ handle: 'alice@pay.test' }))[1].pubkey).toBe(victim.identityKey);

    // Attacker's request resumes.
    release();
    const [as] = await attackerReq;

    // Secure behaviour: the late claimant is refused and the name stays with the victim.
    expect(as).toBe(409);
    expect((await h.pki({ handle: 'alice@pay.test' }))[1].pubkey).toBe(victim.identityKey);
  });

  test('after the race, payments to the victim name derive from the ATTACKER key', async () => {
    const store = pgStore();
    const h = pm.makeHandlers({ store, env: ENV });
    const victim = user();
    const attacker = user();
    const release = store.holdNext(attacker.identityKey);
    const attackerReq = h.register({}, await attacker.sign('register', { alias: 'alice' }));
    await new Promise((r) => setTimeout(r, 20));
    expect((await h.register({}, await victim.sign('register', { alias: 'alice' })))[0]).toBe(200);
    release();
    await attackerReq;
    // Secure: still the victim. Today pki (and so every p2p destination the server derives) names the attacker.
    expect((await h.pki({ handle: 'alice@pay.test' }))[1].pubkey).toBe(victim.identityKey);
  });
});
