import { describe, expect, test } from 'bun:test';
import { OP, P2PKH, PrivateKey, ProtoWallet, Script, Transaction, Utils } from '@bsv/sdk';
import hn from '../lib/handleNft.js';
import pm from '../lib/paymail.js';

const ENV = { PAYMAIL_DOMAIN: 'pay.test', NODE_ENV: 'test' };
const alice = new PrivateKey(11);
const bob = new PrivateKey(12);
const mallory = new PrivateKey(13);
const pub = (k) => k.toPublicKey().toString();
const A = pub(alice);
const B = pub(bob);
const M = pub(mallory);
const PREV = 'aa'.repeat(32);

const sign = async (key, b) => {
  const { signature } = await new ProtoWallet(key).createSignature({
    data: Utils.toArray(hn.bindingMessage(b), 'utf8'),
    protocolID: [2, 'bwallet paymail'],
    keyID: '1',
    counterparty: 'anyone',
  });
  return Utils.toHex(signature);
};

/** A binding signed by `key` as the signer. */
const binding = async (key, b) => {
  const full = { origin: '', ...b, signer: pub(key) };
  return { ...full, sig: await sign(key, full) };
};

const mapTail = (s, b) => {
  const fields = {
    app: 'bwalletx',
    type: 'handle',
    [hn.MAP_KEYS.alias]: b.alias,
    [hn.MAP_KEYS.origin]: b.origin || '',
    [hn.MAP_KEYS.spent]: b.spent,
    [hn.MAP_KEYS.to]: b.to,
    [hn.MAP_KEYS.signer]: b.signer,
    [hn.MAP_KEYS.sig]: b.sig,
  };
  s.writeOpCode(OP.OP_RETURN).writeBin(Utils.toArray(hn.MAP_PREFIX, 'utf8')).writeBin(Utils.toArray('SET', 'utf8'));
  for (const [k, v] of Object.entries(fields))
    s.writeBin(Utils.toArray(k, 'utf8')).writeBin(Utils.toArray(v || '', 'utf8'));
  return s;
};

/** An output script like 1Sat writes it: [inscription] P2PKH [OP_RETURN MAP SET …], round-tripped through hex. */
const outScript = (owner, { inscription, bind } = {}) => {
  const s = new Script();
  if (inscription) {
    s.writeOpCode(OP.OP_0)
      .writeOpCode(OP.OP_IF)
      .writeBin(Utils.toArray('ord', 'utf8'))
      .writeOpCode(OP.OP_1)
      .writeBin(Utils.toArray(hn.CONTENT_TYPE, 'utf8'))
      .writeOpCode(OP.OP_0)
      .writeBin(Utils.toArray(inscription, 'utf8'))
      .writeOpCode(OP.OP_ENDIF);
  }
  for (const ch of new P2PKH().lock(owner.toPublicKey().toAddress()).chunks) s.chunks.push(ch);
  if (bind) mapTail(s, bind);
  return Script.fromHex(s.toHex());
};

const txSpending = (spent, script) => {
  const tx = new Transaction();
  if (spent) {
    const [txid, vout] = spent.split('_');
    tx.addInput({ sourceTXID: txid, sourceOutputIndex: Number(vout), unlockingScript: new Script() });
  } else tx.addInput({ sourceTXID: PREV, sourceOutputIndex: 0, unlockingScript: new Script() });
  tx.addOutput({ lockingScript: script, satoshis: 1 });
  return tx;
};

const mintTx = async (alias = 'neo', key = alice, domain = 'pay.test') => {
  const b = await binding(key, { alias, spent: hn.GENESIS, to: pub(key) });
  return txSpending(null, outScript(key, { inscription: hn.handleContent(alias, domain), bind: b }));
};

/** Chain mock: `latest` answers the given location; txs by id. */
const chainOf = (latest, txs = []) => ({
  latest: async () => (latest instanceof Error ? Promise.reject(latest) : latest),
  tx: async (id) => txs.find((t) => t.id('hex') === id) ?? null,
});

describe('handle NFT content + binding', () => {
  test('content round-trips through an inscription', () => {
    const s = outScript(alice, { inscription: hn.handleContent('neo', 'pay.test') });
    expect(hn.parseHandleContent(hn.readInscription(s))).toEqual({ alias: 'neo', domain: 'pay.test' });
  });

  test('a binding signed by its signer verifies; any changed field does not', async () => {
    const b = await binding(alice, { alias: 'neo', spent: `${PREV}_0`, origin: `${PREV}_1`, to: B });
    expect(await hn.verifyBinding(b)).toBe(true);
    expect(await hn.verifyBinding({ ...b, to: M })).toBe(false);
    expect(await hn.verifyBinding({ ...b, alias: 'trinity' })).toBe(false);
    expect(await hn.verifyBinding({ ...b, spent: `${PREV}_9` })).toBe(false);
    expect(await hn.verifyBinding({ ...b, signer: M })).toBe(false);
  });

  test('readBinding reads the MAP on the NFT output', async () => {
    const b = await binding(alice, { alias: 'neo', spent: `${PREV}_0`, origin: `${PREV}_1`, to: B });
    const tx = txSpending(`${PREV}_0`, outScript(bob, { bind: b }));
    const r = hn.readBinding(tx, 0);
    expect(r).toMatchObject({ alias: 'neo', to: B, signer: A, spent: `${PREV}_0` });
    expect(await hn.verifyBinding(r)).toBe(true);
  });

  test('checkMint accepts a genesis self-binding by the owner and refuses the rest', async () => {
    const ok = await mintTx();
    const opts = { alias: 'neo', identityKey: A, domains: ['pay.test'] };
    expect(await hn.checkMint(ok, 0, opts)).toBeNull();
    expect(await hn.checkMint(ok, 0, { ...opts, identityKey: B })).toBe('The mint is bound to another key');
    expect(await hn.checkMint(ok, 0, { ...opts, alias: 'other' })).toBe('That inscription is not this handle');
    expect(await hn.checkMint(await mintTx('neo', alice, 'evil.test'), 0, opts)).toBe(
      'That inscription names another domain',
    );
  });
});

describe('resolver precedence', () => {
  const ORIGIN = `${'11'.repeat(32)}_0`;
  const row = (extra = {}) => ({
    alias: 'neo',
    identity_key: A,
    nft_origin: ORIGIN,
    nft_location: ORIGIN,
    nft_unbound: false,
    nft_frozen: false,
    ...extra,
  });
  const moveTo = async (signerKey, to, spent = ORIGIN, alias = 'neo') => {
    const b = await binding(signerKey, { alias, origin: ORIGIN, spent, to });
    return txSpending(spent, outScript(bob, { bind: b }));
  };

  test('an untokenised row is the DB answer and never touches the chain', async () => {
    const chain = { latest: () => Promise.reject(new Error('called')), tx: () => Promise.reject(new Error('called')) };
    expect(await hn.resolveHandle(row({ nft_origin: null }), chain)).toMatchObject({ key: A, via: 'db' });
  });

  test('frozen answers nothing', async () => {
    expect(await hn.resolveHandle(row({ nft_frozen: true }), chainOf({ outpoint: ORIGIN }))).toMatchObject({
      key: null,
      via: 'frozen',
    });
  });

  test('unmoved NFT = last verified holder', async () => {
    expect(await hn.resolveHandle(row(), chainOf({ outpoint: ORIGIN.replace('_', '.') }))).toMatchObject({
      key: A,
      via: 'same',
    });
  });

  test('indexer down = last verified holder (stale), unbound stays nothing', async () => {
    expect(await hn.resolveHandle(row(), chainOf(new Error('503')))).toMatchObject({ key: A, via: 'stale' });
    expect(await hn.resolveHandle(row({ nft_unbound: true }), chainOf(new Error('503')))).toMatchObject({
      key: null,
    });
  });

  test('burned / spent NFT answers nothing', async () => {
    expect(await hn.resolveHandle(row(), chainOf({ outpoint: ORIGIN, spent: true }))).toMatchObject({
      key: null,
      via: 'gone',
    });
    expect(await hn.resolveHandle(row(), chainOf(null))).toMatchObject({ key: null, via: 'gone' });
  });

  test('designation by the previous holder moves it to the named key', async () => {
    const tx = await moveTo(alice, B);
    const r = await hn.resolveHandle(row(), chainOf({ outpoint: `${tx.id('hex')}_0` }, [tx]));
    expect(r).toMatchObject({ key: B, via: 'designated', location: `${tx.id('hex')}_0` });
  });

  test("a designation by anyone else leaves it unbound (stolen NFT can't name a thief's key)", async () => {
    const tx = await moveTo(mallory, B);
    expect(await hn.resolveHandle(row(), chainOf({ outpoint: `${tx.id('hex')}_0` }, [tx]))).toMatchObject({
      key: null,
      via: 'unbound',
    });
  });

  test('a self-claim by the holder binds the holder', async () => {
    const tx = await moveTo(mallory, M);
    expect(await hn.resolveHandle(row(), chainOf({ outpoint: `${tx.id('hex')}_0` }, [tx]))).toMatchObject({
      key: M,
      via: 'self',
    });
  });

  test('a binding for another alias, a spent outpoint not in the tx, or no binding = unbound', async () => {
    const wrongAlias = await moveTo(alice, B, ORIGIN, 'trinity');
    const notSpent = await (async () => {
      const b = await binding(alice, { alias: 'neo', origin: ORIGIN, spent: ORIGIN, to: B });
      return txSpending(`${'22'.repeat(32)}_0`, outScript(bob, { bind: b }));
    })();
    const plain = txSpending(ORIGIN, outScript(bob));
    for (const tx of [wrongAlias, notSpent, plain])
      expect(await hn.resolveHandle(row(), chainOf({ outpoint: `${tx.id('hex')}_0` }, [tx]))).toMatchObject({
        key: null,
        via: 'unbound',
      });
  });

  test('designation needs the spent outpoint to be the last verified location', async () => {
    const tx = await moveTo(alice, B, `${'33'.repeat(32)}_0`);
    expect(await hn.resolveHandle(row(), chainOf({ outpoint: `${tx.id('hex')}_0` }, [tx]))).toMatchObject({
      key: null,
      via: 'unbound',
    });
  });

  test('from unbound, only a self-claim binds again', async () => {
    const UNB = `${'44'.repeat(32)}_0`;
    const designated = await moveTo(alice, B, UNB);
    const unb = row({ nft_location: UNB, nft_unbound: true });
    expect(await hn.resolveHandle(unb, chainOf({ outpoint: `${designated.id('hex')}_0` }, [designated]))).toMatchObject(
      { key: null },
    );
    const self = await moveTo(bob, B, UNB);
    expect(await hn.resolveHandle(unb, chainOf({ outpoint: `${self.id('hex')}_0` }, [self]))).toMatchObject({
      key: B,
      via: 'self',
    });
  });

  test('cached resolver calls onMove once and caches for the TTL', async () => {
    const tx = await moveTo(alice, B);
    let calls = 0;
    const moves = [];
    const chain = chainOf({ outpoint: `${tx.id('hex')}_0` }, [tx]);
    const resolve = hn.makeHandleResolver({
      chain: { latest: (o) => (calls++, chain.latest(o)), tx: chain.tx },
      now: () => 1000,
      onMove: (r, v) => moves.push(v.via),
    });
    await resolve(row());
    await resolve(row());
    expect(calls).toBe(1);
    expect(moves).toEqual(['designated']);
  });
});

describe('paymail server follows the NFT', () => {
  const ORIGIN = `${'11'.repeat(32)}_0`;
  const memStore = (rows) => {
    const by = new Map(rows.map((r) => [r.alias, { ...r }]));
    const events = [];
    return {
      events,
      rows: by,
      getAlias: async (a) => by.get(a) ?? null,
      getAliasByKey: async (k) => [...by.values()].find((r) => r.identity_key === k && r.is_primary) ?? null,
      moveHandle: async (alias, from, patch) => {
        const r = by.get(alias);
        if (r && r.nft_location === from) Object.assign(r, patch);
      },
      setHandleNft: async (alias, k, origin) => {
        const r = by.get(alias);
        if (r && r.identity_key === k && !r.nft_origin) Object.assign(r, { nft_origin: origin, nft_location: origin });
      },
      recordHandleEvent: async (e) => events.push(e),
      countRecentPayments: async () => 0,
      insertPayment: async () => undefined,
    };
  };

  test('pki answers the DB key before tokenising and the NFT holder after a designated send', async () => {
    const store = memStore([
      { alias: 'neo', identity_key: A, kind: 'plain', is_primary: false, nft_origin: ORIGIN, nft_location: ORIGIN },
      { alias: 'bob', identity_key: B, kind: 'plain', is_primary: true, ord_address: '1BobOrdAddressxxxxxxxxxxxxxxx' },
      { alias: 'plainname', identity_key: A, kind: 'plain', is_primary: true },
    ]);
    const b = await binding(alice, { alias: 'neo', origin: ORIGIN, spent: ORIGIN, to: B });
    const tx = txSpending(ORIGIN, outScript(bob, { bind: b }));
    const h = pm.makeHandlers({ store, env: ENV, handleChain: chainOf({ outpoint: `${tx.id('hex')}_0` }, [tx]) });
    expect((await h.pki({ handle: 'plainname@pay.test' }))[1].pubkey).toBe(A);
    const [s, out] = await h.pki({ handle: 'neo@pay.test' });
    expect(s).toBe(200);
    expect(out.pubkey).toBe(B);
    expect(store.rows.get('neo')).toMatchObject({
      identity_key: B,
      is_primary: false,
      nft_location: `${tx.id('hex')}_0`,
    });
    expect(store.events.map((e) => e.kind)).toEqual(['designated']);
  });

  test('an unbound handle answers 404 for payments', async () => {
    const store = memStore([
      { alias: 'neo', identity_key: A, kind: 'plain', nft_origin: ORIGIN, nft_location: ORIGIN },
    ]);
    const tx = txSpending(ORIGIN, outScript(mallory));
    const h = pm.makeHandlers({ store, env: ENV, handleChain: chainOf({ outpoint: `${tx.id('hex')}_0` }, [tx]) });
    const [s] = await h.p2pDestination({ handle: 'neo@pay.test' }, { satoshis: 100 });
    expect(s).toBe(404);
    expect(store.rows.get('neo').nft_unbound).toBe(true);
  });

  test('handle-nft-bind tokenises a valid mint signed by the owner', async () => {
    const mint = await mintTx('neo', alice);
    const origin = `${mint.id('hex')}_0`;
    const store = memStore([{ alias: 'neo', identity_key: A, kind: 'plain' }]);
    const h = pm.makeHandlers({ store, env: ENV, handleChain: chainOf({ outpoint: origin }, [mint]) });
    const now = Date.now();
    const fields = { alias: 'neo', origin };
    const all = { ...fields, identityKey: A, timestamp: String(now) };
    const { signature } = await new ProtoWallet(alice).createSignature({
      data: Utils.toArray(pm.signedMessage('handle-nft-bind', all), 'utf8'),
      protocolID: [2, 'bwallet paymail'],
      keyID: '1',
      counterparty: 'anyone',
    });
    const body = { identityKey: A, timestamp: now, fields, signature: Utils.toHex(signature) };
    expect(await h['handle-nft-bind']({}, body)).toEqual([200, { alias: 'neo', origin }]);
    expect(store.rows.get('neo').nft_origin).toBe(origin);
    // Someone else can't tokenise it: signed by bob, not the owner.
    const store2 = memStore([{ alias: 'neo', identity_key: A, kind: 'plain' }]);
    const h2 = pm.makeHandlers({ store: store2, env: ENV, handleChain: chainOf({ outpoint: origin }, [mint]) });
    const allB = { ...fields, identityKey: B, timestamp: String(now) };
    const sigB = await new ProtoWallet(bob).createSignature({
      data: Utils.toArray(pm.signedMessage('handle-nft-bind', allB), 'utf8'),
      protocolID: [2, 'bwallet paymail'],
      keyID: '1',
      counterparty: 'anyone',
    });
    const [s2] = await h2['handle-nft-bind']({}, { ...body, identityKey: B, signature: Utils.toHex(sigB.signature) });
    expect(s2).toBe(404);
  });
});
