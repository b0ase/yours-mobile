import { describe, expect, test } from 'bun:test';
import { LockingScript, OP, PrivateKey, ProtoWallet, PushDrop, Script, Transaction, Utils } from '@bsv/sdk';
import opns from '../lib/opnsResolve.js';
import pm from '../lib/paymail.js';

const { makeOpnsResolver, SERVICES, OPNS_PROTOCOL } = opns;
const OURS = ['bwalletx.com', 'bwallet.space'];
const ENV = { PAYMAIL_DOMAIN: 'bwalletx.com', PAYMAIL_DOMAINS: 'bwallet.space' };
const SPENT_TXID = 'ab'.repeat(32);
const ORIGIN = `${'cd'.repeat(32)}_2`;

const utf8 = (s) => Utils.toArray(s, 'utf8');
/** DAG-CBOR {domain, name?} with short text strings (what @1sat/utils encodeProfile writes). */
const cborProfile = (domain, name) => {
  const text = (s) => [0x60 + utf8(s).length, ...utf8(s)];
  return [name ? 0xa2 : 0xa1, ...text('domain'), ...text(domain), ...(name ? [...text('name'), ...text(name)] : [])];
};

/** A registerOpns-style publish: name coin locked in a signed PushDrop (identity + profile). */
async function publishTx(priv, { domain = 'bwalletx.com', name, signer = priv, identity } = {}) {
  const wallet = new ProtoWallet(signer);
  const idKey = identity ?? priv.toPublicKey().toString();
  const keyID = `opns:${SPENT_TXID}_0`;
  const fields = [utf8('identity'), Utils.toArray(idKey, 'hex'), utf8('profile'), cborProfile(domain, name)];
  const { signature } = await wallet.createSignature({
    data: fields.flat(),
    protocolID: OPNS_PROTOCOL,
    keyID,
    counterparty: 'anyone',
  });
  const lock = await new PushDrop(wallet).lock([...fields, signature], OPNS_PROTOCOL, keyID, 'anyone', true, false);
  const tx = new Transaction();
  tx.addInput({ sourceTXID: SPENT_TXID, sourceOutputIndex: 0, unlockingScript: new Script(), sequence: 0xffffffff });
  tx.addOutput({ lockingScript: lock, satoshis: 1 });
  return tx;
}

/** Legacy: plain output + MAP SET opns.idKey in an OP_RETURN of the same tx. */
function mapTx(idKey) {
  const tx = new Transaction();
  tx.addInput({ sourceTXID: SPENT_TXID, sourceOutputIndex: 0, unlockingScript: new Script(), sequence: 0xffffffff });
  tx.addOutput({ lockingScript: new LockingScript([{ op: OP.OP_TRUE }]), satoshis: 1 });
  const push = (s) => ({ op: utf8(s).length, data: utf8(s) });
  const map = new LockingScript([
    { op: OP.OP_FALSE },
    { op: OP.OP_RETURN },
    push('1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5'),
    push('SET'),
    push('opns.idKey'),
    { op: OP.OP_PUSHDATA1, data: utf8(idKey) },
  ]);
  tx.addOutput({ lockingScript: map, satoshis: 0 });
  return tx;
}

/** Fake indexers: name → { tx, spend }. Counts calls. */
function fakeFetch(names) {
  const calls = { n: 0 };
  const json = (v, ok = true) => ({ ok, json: async () => v, text: async () => JSON.stringify(v) });
  const f = async (url) => {
    calls.n++;
    for (const [name, r] of Object.entries(names)) {
      const loc = `${r.tx.id('hex')}_0`;
      if (url === `${SERVICES.opns}/${name}`) return json({ origin: ORIGIN, outpoint: loc, domain: name, map: null });
      if (url === `${SERVICES.latest}/${ORIGIN}/latest?script=false` && r.current)
        return json({ outpoint: loc, spend: r.spend ?? '' });
      if (url === `${SERVICES.rawTx}/${r.tx.id('hex')}/hex`) return { ok: true, text: async () => r.tx.toHex() };
    }
    return json({ message: 'Not Found' }, false);
  };
  return { f, calls };
}

describe('OpNS resolver', () => {
  test('a signed PushDrop publish for our domain resolves to its identity key and name', async () => {
    const priv = PrivateKey.fromRandom();
    const { f } = fakeFetch({ alice: { tx: await publishTx(priv, { name: 'Alice' }), current: true } });
    const r = await makeOpnsResolver({ f })('alice', OURS);
    expect(r.identityKey).toBe(priv.toPublicKey().toString());
    expect(r.displayName).toBe('Alice');
  });

  test("another ecosystem's domain, a forged identity, or a spent name do not resolve", async () => {
    const priv = PrivateKey.fromRandom();
    const other = PrivateKey.fromRandom();
    const cases = [
      { tx: await publishTx(priv, { domain: '1sat.name' }), current: true },
      // Signed by someone else but naming priv's identity key: lock key / signature don't derive from it.
      { tx: await publishTx(priv, { signer: other, identity: priv.toPublicKey().toString() }), current: true },
      { tx: await publishTx(priv), current: true, spend: 'ee'.repeat(32) },
    ];
    for (const c of cases) {
      const { f } = fakeFetch({ alice: c });
      expect(await makeOpnsResolver({ f })('alice', OURS)).toBeNull();
    }
  });

  test('legacy MAP opns.idKey in the current transaction resolves', async () => {
    const key = PrivateKey.fromRandom().toPublicKey().toString();
    const { f } = fakeFetch({ bob: { tx: mapTx(key), current: true } });
    expect((await makeOpnsResolver({ f })('bob', OURS)).identityKey).toBe(key);
  });

  test('caches hits and misses briefly', async () => {
    const priv = PrivateKey.fromRandom();
    const { f, calls } = fakeFetch({ alice: { tx: await publishTx(priv), current: true } });
    let t = 0;
    const resolve = makeOpnsResolver({ f, now: () => t, ttl: 1000 });
    await resolve('alice', OURS);
    await resolve('nobody', OURS);
    const n = calls.n;
    await resolve('alice', OURS);
    await resolve('nobody', OURS);
    expect(calls.n).toBe(n);
    t = 2000;
    await resolve('alice', OURS);
    expect(calls.n).toBeGreaterThan(n);
  });

  test('rejects malformed names without a lookup', async () => {
    const { f, calls } = fakeFetch({});
    expect(await makeOpnsResolver({ f })('../x', OURS)).toBeNull();
    expect(calls.n).toBe(0);
  });
});

describe('paymail answers OpNS names', () => {
  const memStore = (rows = {}) => ({
    getAlias: async (a) => rows[a] ?? null,
    getForward: async () => null,
  });

  test('pki / profile / verify answer an OpNS-bound name; payments and ord do not', async () => {
    const key = PrivateKey.fromRandom().toPublicKey().toString();
    const opnsFn = async (name) => (name === 'carol' ? { identityKey: key, displayName: 'Carol' } : null);
    const h = pm.makeHandlers({ store: memStore(), env: ENV, opns: opnsFn });
    const [s, r] = await h.pki({ handle: 'carol@bwalletx.com' });
    expect(s).toBe(200);
    expect(r.pubkey).toBe(key);
    expect(r.handle).toBe('carol@bwalletx.com');
    expect((await h.profile({ handle: 'carol@bwalletx.com' }))[1].name).toBe('Carol');
    expect((await h.verify({ handle: 'carol@bwalletx.com', pubkey: key }))[1].match).toBe(true);
    expect((await h.ord({ handle: 'carol@bwalletx.com' }))[0]).toBe(404);
    expect((await h.p2pDestination({ handle: 'carol@bwalletx.com' }, { satoshis: 10 }))[0]).toBe(404);
    expect((await h.pki({ handle: 'nobody@bwalletx.com' }))[0]).toBe(404);
  });

  test('a claimed alias always wins over an OpNS name', async () => {
    const claimed = PrivateKey.fromRandom().toPublicKey().toString();
    const squatter = PrivateKey.fromRandom().toPublicKey().toString();
    let asked = 0;
    const opnsFn = async () => (asked++, { identityKey: squatter, displayName: 'x' });
    const h = pm.makeHandlers({
      store: memStore({ dave: { alias: 'dave', identity_key: claimed, display_name: 'Dave' } }),
      env: ENV,
      opns: opnsFn,
    });
    expect((await h.pki({ handle: 'dave@bwalletx.com' }))[1].pubkey).toBe(claimed);
    expect((await h.profile({ handle: 'dave@bwalletx.com' }))[1].name).toBe('Dave');
    expect(asked).toBe(0);
  });
});
