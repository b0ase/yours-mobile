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

const store = (rows) => {
  const aliases = new Map(rows.map((r) => [r.alias, r]));
  const bindings = new Map();
  const log = [];
  return {
    log,
    getAlias: async (a) => aliases.get(a) ?? null,
    getAliasByKey: async (k) => [...aliases.values()].find((r) => r.identity_key === k) ?? null,
    getForward: async () => null,
    getBinding: async (a) => bindings.get(a) ?? null,
    putBinding: async (b) => void bindings.set(b.alias, { ...b }),
    logName: async (r) => void log.push(r),
    nameLog: async (a) => log.filter((r) => !a || r.alias === a).reverse(),
  };
};

/** What a wallet does with a pki answer: rebuild the signed message and check it against the served key. */
const verify = async (out) => {
  const b = out.binding;
  if (!b) return 'unsigned';
  const fields = { alias: b.alias, seq: String(b.seq), identityKey: out.pubkey, timestamp: b.timestamp };
  const { valid } = await new ProtoWallet('anyone')
    .verifySignature({
      data: Utils.toArray(pm.signedMessage('bind', fields), 'utf8'),
      signature: Utils.toArray(b.signature, 'hex'),
      protocolID: pm.SIGN_PROTOCOL,
      keyID: pm.SIGN_KEY_ID,
      counterparty: out.pubkey,
    })
    .catch(() => ({ valid: false }));
  return valid ? 'signed' : 'bad';
};

describe('signed name bindings', () => {
  test('the owner signs a binding; pki serves it and any wallet can verify it; it is logged', async () => {
    const owner = user();
    const s = store([{ alias: 'npg', identity_key: owner.identityKey, kind: 'plain' }]);
    const h = pm.makeHandlers({ store: s, env: ENV });
    const [st] = await h.bind({}, await owner.sign('bind', { alias: 'npg', seq: '1' }));
    expect(st).toBe(200);
    const [, out] = await h.pki({ handle: 'npg@pay.test' });
    expect(out.binding.seq).toBe(1);
    expect(await verify(out)).toBe('signed');
    expect(s.log).toMatchObject([{ alias: 'npg', action: 'bind', actor: 'owner', seq: 1 }]);
  });

  test('only the wallet the name points to can sign it, and seq must go up', async () => {
    const owner = user();
    const other = user();
    const s = store([{ alias: 'npg', identity_key: owner.identityKey, kind: 'plain' }]);
    const h = pm.makeHandlers({ store: s, env: ENV });
    expect((await h.bind({}, await other.sign('bind', { alias: 'npg', seq: '1' })))[0]).toBe(403);
    expect((await h.bind({}, await owner.sign('bind', { alias: 'npg', seq: '2' })))[0]).toBe(200);
    expect((await h.bind({}, await owner.sign('bind', { alias: 'npg', seq: '2' })))[0]).toBe(409);
    expect((await h.bind({}, await owner.sign('bind', { alias: 'npg', seq: '1' })))[0]).toBe(409);
  });

  test('a name quietly repointed in the database loses its binding: wallets see it unsigned', async () => {
    const owner = user();
    const thief = user();
    const row = { alias: 'npg', identity_key: owner.identityKey, kind: 'plain' };
    const s = store([row]);
    const h = pm.makeHandlers({ store: s, env: ENV });
    await h.bind({}, await owner.sign('bind', { alias: 'npg', seq: '1' }));
    row.identity_key = thief.identityKey; // a direct edit, bypassing the signed API
    const [, out] = await h.pki({ handle: 'npg@pay.test' });
    expect(out.pubkey).toBe(thief.identityKey);
    expect(out.binding).toBeUndefined();
    expect(await verify(out)).toBe('unsigned');
  });

  test('a forged binding (signature for another key) fails verification', async () => {
    const owner = user();
    const s = store([{ alias: 'npg', identity_key: owner.identityKey, kind: 'plain' }]);
    const h = pm.makeHandlers({ store: s, env: ENV });
    await h.bind({}, await owner.sign('bind', { alias: 'npg', seq: '1' }));
    const [, out] = await h.pki({ handle: 'npg@pay.test' });
    expect(await verify({ ...out, binding: { ...out.binding, alias: 'other' } })).toBe('bad');
  });

  test('name-log is public', async () => {
    const owner = user();
    const s = store([{ alias: 'npg', identity_key: owner.identityKey, kind: 'plain' }]);
    const h = pm.makeHandlers({ store: s, env: ENV });
    await h.bind({}, await owner.sign('bind', { alias: 'npg', seq: '1' }));
    const [st, out] = await h['name-log']({ alias: 'npg' });
    expect(st).toBe(200);
    expect(out.log.length).toBe(1);
  });
});
