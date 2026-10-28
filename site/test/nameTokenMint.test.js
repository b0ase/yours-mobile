// Free name token mint: bCorp's sponsor key (a random test key here) pays; the token goes to the owner's address.
import { describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, ProtoWallet, Transaction, Utils } from '@bsv/sdk';
import pm from '../lib/paymail.js';
import { makeSponsor, CONTENT_TYPE } from '../lib/nameTokenMint.js';

const sponsor = PrivateKey.fromRandom();
const funding = new Transaction();
funding.addOutput({ lockingScript: new P2PKH().lock(sponsor.toAddress()), satoshis: 10_000 });
const chain = {
  utxos: async () => [{ txid: funding.id('hex'), vout: 0, satoshis: 10_000 }],
  // The library loads the CommonJS build of @bsv/sdk: hand it a transaction from that build.
  tx: async (id) => (id === funding.id('hex') ? require('@bsv/sdk').Transaction.fromHex(funding.toHex()) : null),
};
const ENV = { BWALLET_NAME_MINT_ENABLED: '1', BWALLET_NAME_SPONSOR_WIF: sponsor.toWif(), PAYMAIL_DOMAIN: 'pay.test' };
const binding = { identityKey: '02' + 'a'.repeat(64), seq: 1, timestamp: '1', signature: 'ab', scheme: 's' };

describe('sponsor', () => {
  test('off unless switched on', async () => {
    await expect(
      makeSponsor({ env: {}, chain, broadcast: async () => {} })({
        alias: 'a',
        domain: 'd',
        binding,
        ordAddress: sponsor.toAddress(),
      }),
    ).rejects.toThrow('not switched on');
  });
  test('mints 1 sat to the owner, change back to the sponsor, inscription carries the name and binding', async () => {
    const sent = [];
    const owner = PrivateKey.fromRandom().toAddress();
    const m = await makeSponsor({ env: ENV, chain, broadcast: async (tx) => void sent.push(tx) })({
      alias: 'richard.gmail',
      domain: 'pay.test',
      binding,
      ordAddress: owner,
    });
    const tx = sent[0];
    expect(m.origin).toBe(`${tx.id('hex')}_0`);
    expect(tx.outputs[0].satoshis).toBe(1);
    const hex = tx.outputs[0].lockingScript.toHex();
    expect(hex).toContain(Utils.toHex(Utils.toArray(CONTENT_TYPE, 'utf8')));
    expect(hex).toContain(Utils.toHex(Utils.toArray('richard.gmail@pay.test', 'utf8')));
    expect(hex.endsWith(new P2PKH().lock(owner).toHex())).toBe(true);
    expect(tx.outputs[1].lockingScript.toHex()).toBe(new P2PKH().lock(sponsor.toAddress()).toHex());
  });
  test('daily cap', async () => {
    const s = makeSponsor({ env: { ...ENV, BWALLET_NAME_MINT_DAILY: '1' }, chain, broadcast: async () => {} });
    const a = { alias: 'x', domain: 'd', binding, ordAddress: sponsor.toAddress() };
    await s(a);
    await expect(s(a)).rejects.toThrow('paused');
  });
});

const user = () => {
  const priv = PrivateKey.fromRandom();
  const wallet = new ProtoWallet(priv);
  const identityKey = priv.toPublicKey().toString();
  const sign = async (action, fields) => {
    const timestamp = Date.now();
    const all = {
      ...fields,
      nonce: Utils.toHex(PrivateKey.fromRandom().toArray().slice(0, 16)),
      identityKey,
      timestamp: String(timestamp),
    };
    const { signature } = await wallet.createSignature({
      data: Utils.toArray(pm.signedMessage(action, all), 'utf8'),
      protocolID: pm.SIGN_PROTOCOL,
      keyID: pm.SIGN_KEY_ID,
      counterparty: 'anyone',
    });
    const { identityKey: _k, timestamp: _t, ...f } = all;
    return { identityKey, timestamp, fields: f, signature: Utils.toHex(signature) };
  };
  return { priv, identityKey, sign };
};
const store = () => {
  const aliases = new Map();
  const origins = new Map();
  const bindings = new Map();
  return {
    aliases,
    origins,
    bindings,
    getAlias: async (a) => aliases.get(a) ?? null,
    getBinding: async (a) => bindings.get(a) ?? null,
    nameTokenOrigin: async (n) => origins.get(n) ?? null,
    putNameTokenOrigin: async (r) => void origins.set(r.name, r),
    logName: async () => {},
  };
};

describe('name-token-mint handler', () => {
  test('only the owner, only once, only after the binding is signed', async () => {
    const s = store();
    const u = user();
    const v = user();
    s.aliases.set('richard.gmail', {
      alias: 'richard.gmail',
      identity_key: u.identityKey,
      ord_address: u.priv.toAddress(),
    });
    const calls = [];
    const mintNameToken = async (a) => (calls.push(a), { txid: 'f'.repeat(64), origin: `${'f'.repeat(64)}_0` });
    const h = pm.makeHandlers({ store: s, env: ENV, mintNameToken });
    const ask = (w) => w.sign('name-token-mint', { alias: 'richard.gmail', ordAddress: w.priv.toAddress() });
    expect((await h['name-token-mint']({}, await ask(v)))[0]).toBe(403);
    expect((await h['name-token-mint']({}, await ask(u)))[0]).toBe(409); // no binding yet
    s.bindings.set('richard.gmail', {
      alias: 'richard.gmail',
      identity_key: u.identityKey,
      seq: 1,
      signature: 'ab',
      signed_at: new Date().toISOString(),
    });
    const [st, out] = await h['name-token-mint']({}, await ask(u));
    expect(st).toBe(200);
    expect(out.origin).toBe(`${'f'.repeat(64)}_0`);
    expect(calls[0].binding.identityKey).toBe(u.identityKey);
    expect((await h['name-token-mint']({}, await ask(u)))[0]).toBe(409); // already a token
  });
  test('name-token: the badge applies only while the minting wallet holds it', async () => {
    const s = store();
    const u = user();
    s.aliases.set('richard.gmail', {
      alias: 'richard.gmail',
      identity_key: u.identityKey,
      ord_address: u.priv.toAddress(),
    });
    s.origins.set('richard.gmail', { name: 'richard.gmail', origin: `${'e'.repeat(64)}_0` });
    let at = u.priv.toAddress();
    const nameTokenHolder = async () => ({ outpoint: 'x', address: at, listed: false, burned: false });
    const h = pm.makeHandlers({ store: s, env: ENV, nameTokenHolder });
    expect((await h['name-token']({ handle: 'richard.gmail@pay.test' }))[1].proofApplies).toBe(true);
    at = PrivateKey.fromRandom().toAddress();
    const r = (await h['name-token']({ handle: 'richard.gmail@pay.test' }))[1];
    expect(r.moved).toBe(true);
    expect(r.proofApplies).toBe(false);
  });
});
