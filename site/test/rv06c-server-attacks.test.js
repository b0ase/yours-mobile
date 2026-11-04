// 06c re-review (4 Nov 2026): attacks on the claim intent and the new server rules (fix/store-safe c3000ce6).
// Reviewer's file, kept as a regression suite: the tests marked FLIPPED asserted the bugs the 06c round fixed
// (L1, L2, L3) and now assert the fix; the rest are unchanged.
import { describe, expect, test } from 'bun:test';
import { Beef, MerklePath, P2PKH, PrivateKey, ProtoWallet, Script, Transaction, Utils } from '@bsv/sdk';
import pm from '../lib/paymail.js';
import ptx from '../lib/paidTxids.js';
import tb from '../lib/themeBuys.js';
import to from '../lib/themeOrders.js';

let NOW = 1_800_000_000_000;
const PAY = new PrivateKey(7).toPublicKey().toAddress();

const user = (n) => {
  const priv = new PrivateKey(n);
  const wallet = new ProtoWallet(priv);
  const identityKey = priv.toPublicKey().toString();
  const sign = async (action, fields = {}, extra = {}) => {
    const all = { ...fields, identityKey, timestamp: String(NOW) };
    const { signature } = await wallet.createSignature({
      data: Utils.toArray(pm.signedMessage(action, all), 'utf8'),
      protocolID: pm.SIGN_PROTOCOL,
      keyID: pm.SIGN_KEY_ID,
      counterparty: 'anyone',
    });
    return { identityKey, timestamp: NOW, fields, signature: Utils.toHex(signature), ...extra };
  };
  return { identityKey, sign };
};

const memStore = () => {
  const rows = [];
  const events = [];
  const s = {
    rows,
    events,
    getByQuote: async (q) => {
      const r = rows.find((x) => x.quote_id === q);
      return r ? { ...r } : null;
    },
    getByTxid: async (t) => rows.find((r) => r.txid === t) ?? null,
    setTxidIfEmpty: async (id, txid) => {
      const r = rows.find((x) => x.id === id);
      if (!r || r.txid) return false;
      r.txid = txid;
      return true;
    },
    owned: async (k) => rows.filter((r) => r.identity_key === k && r.status === 'paid'),
    pending: async (k) => rows.filter((r) => r.identity_key === k && r.status === 'quoted' && r.txid),
    pendingMine: async (k) => rows.filter((r) => r.identity_key === k && r.status === 'quoted' && r.txid),
    listMine: async (k) => rows.filter((r) => r.identity_key === k && r.status !== 'quoted'),
    slugRows: async (slug) => rows.filter((r) => r.slug === slug && r.status !== 'declined').map((r) => ({ ...r })),
    aliasOwner: async () => null,
    notify: async (kind, payload) => void events.push({ kind, payload }),
  };
  s.insert = s.insertOrder = async (r) => (rows.push({ id: `id${rows.length}`, created_at: 'now', ...r }), rows.at(-1));
  s.update = s.updateOrder = async (id, p) =>
    Object.assign(
      rows.find((r) => r.id === id),
      p,
    );
  return s;
};

/** network(txid) answers from a set the test controls; broadcast never accepts (ANNOUNCED). */
const deps = (store, seen = new Set(), extra = {}) => ({
  store,
  ledger: ptx.memoryPaidTxids(),
  rate: async () => 50,
  broadcast: async () => ({ txStatus: 'ANNOUNCED_TO_NETWORK', accepted: false, refused: false }),
  network: async (t) => (seen.has(t) ? 'seen' : 'missing'),
  requireProtocol: true,
  env: { THEME_ORDER_PAY_ADDRESS: PAY },
  now: () => NOW,
  log: () => undefined,
  ...extra,
});

/** A bare raw tx (no parents) paying the quote: inputs nobody can check. */
const bareForgery = (q) => {
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: 'ab'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: new Script(),
    sequence: 0xffffffff,
  });
  tx.addOutput({ lockingScript: new P2PKH().lock(PAY), satoshis: q.sats });
  tx.addOutput({ lockingScript: Script.fromHex(q.memo_hex), satoshis: 0 });
  return tx;
};

/** An AtomicBEEF forgery: a made-up parent with a made-up merkle path, spent with the forger's own (valid) key. */
const beefForgery = async (q) => {
  const k = PrivateKey.fromRandom();
  const parent = new Transaction();
  parent.addInput({
    sourceTXID: '11'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: new Script(),
    sequence: 0xffffffff,
  });
  parent.addOutput({ lockingScript: new P2PKH().lock(k.toAddress()), satoshis: q.sats + 1000 });
  parent.merklePath = new MerklePath(900000, [[{ offset: 0, hash: parent.id('hex'), txid: true }]]);
  const child = new Transaction();
  child.addInput({ sourceTransaction: parent, sourceOutputIndex: 0, unlockingScriptTemplate: new P2PKH().unlock(k) });
  child.addOutput({ lockingScript: new P2PKH().lock(PAY), satoshis: q.sats });
  child.addOutput({ lockingScript: Script.fromHex(q.memo_hex), satoshis: 0 });
  await child.sign();
  const beef = new Beef();
  beef.mergeTransaction(parent);
  beef.mergeTransaction(child);
  return { tx: child, hex: Buffer.from(beef.toBinaryAtomic(child.id('hex'))).toString('hex') };
};

describe('06c: the claim intent', () => {
  test('input-script check: a bare raw-tx forgery AND a made-up-parent BEEF forgery both pass and are recorded', async () => {
    const store = memStore();
    const h = tb.makeThemeBuyHandlers(deps(store));
    const u = user(101);
    const [, q] = await h.quote(await u.sign('theme-buy-quote', { pack: 'npg', store: '2' }));
    const bare = bareForgery(q);
    const r1 = await h.claim(
      await u.sign(
        'theme-buy-claim',
        { quote_id: q.quote_id, txid: bare.id('hex'), store: '2', intent: '1' },
        { rawtx: bare.toHex() },
      ),
    );
    expect(r1[0]).toBe(202);
    expect(store.rows[0].txid).toBe(bare.id('hex'));
    // …and a made-up parent with a fabricated proof verifies under 'scripts only' too.
    const [, q2] = await h.quote(await u.sign('theme-buy-quote', { pack: 'npgx', store: '2' }));
    const f = await beefForgery(q2);
    const r2 = await h.claim(
      await u.sign(
        'theme-buy-claim',
        { quote_id: q2.quote_id, txid: f.tx.id('hex'), store: '2', intent: '1' },
        { rawtx: f.hex },
      ),
    );
    expect(r2[0]).toBe(202);
    // Never paid or owned (the network never has it), so the harm is limited to the forger's own quotes.
    const [, o] = await h.owned(await u.sign('theme-buy-owned', {}));
    expect(o.packs).toEqual([]);
  });

  test("another buyer's quote can't be touched: the claim is bound to the signer's identity key", async () => {
    const store = memStore();
    const h = tb.makeThemeBuyHandlers(deps(store));
    const a = user(201);
    const b = user(202);
    const [, q] = await h.quote(await a.sign('theme-buy-quote', { pack: 'npg', store: '2' }));
    const bare = bareForgery(q);
    const r = await h.claim(
      await b.sign(
        'theme-buy-claim',
        { quote_id: q.quote_id, txid: bare.id('hex'), store: '2', intent: '1' },
        { rawtx: bare.toHex() },
      ),
    );
    expect(r[0]).toBe(404);
    expect(store.rows[0].txid).toBeUndefined();
    // A signed intent replayed as-is is idempotent; its fields (txid, quote, intent) can't be changed.
    const body = await a.sign(
      'theme-buy-claim',
      { quote_id: q.quote_id, txid: bare.id('hex'), store: '2', intent: '1' },
      { rawtx: bare.toHex() },
    );
    expect((await h.claim(body))[0]).toBe(202);
    expect((await h.claim(body))[0]).toBe(202);
    const tampered = { ...body, fields: { ...body.fields, intent: '0' } };
    expect((await h.claim(tampered))[0]).toBe(401);
  });

  // FLIPPED by the 06c fix (L1). The reviewer's original asserted the bug: B was given the slug, one edition went to review.
  test('L1 (fixed): an edition intent (txid recorded, broadcast not yet seen) keeps holding its slug while its quote is live', async () => {
    NOW = 1_800_000_000_000;
    const store = memStore();
    const seen = new Set();
    const h = to.makeThemeOrderHandlers(deps(store, seen));
    const a = user(301);
    const b = user(302);
    const renew = (u, slug) => u.sign('theme-orders-quote', { slug, renew: slug, store: '2' });
    // Seed: A holds nothing yet. A new-edition quote needs files; use the renew-free path through validateOrder.
    const fields = (who) => ({
      slug: 'coolband',
      name: 'Cool Band',
      brand: 'Cool Band',
      isBrand: '0',
      link: 'https://coolband.example',
      colours: JSON.stringify(['#112233', '#445566']),
      files: JSON.stringify([{ path: `${who.identityKey}/${'a'.repeat(64)}.png`, type: 'image/png', size: 10 }]),
      note: '',
      store: '2',
    });
    void renew;
    const [sa, qa] = await h.quote(await a.sign('theme-orders-quote', fields(a)));
    expect(sa).toBe(200);
    // While A's quote is live and A has not paid, B is refused the slug.
    expect((await h.quote(await b.sign('theme-orders-quote', fields(b))))[0]).toBe(409);
    // A taps Pay: the claim intent records A's txid (nothing broadcast yet; the wallet broadcasts next).
    const ta = bareForgery(qa); // stands in for A's real signed payment (the server can't tell the difference)
    expect(
      (
        await h.claim(
          await a.sign(
            'theme-orders-claim',
            { quote_id: qa.quote_id, txid: ta.id('hex'), store: '2', intent: '1' },
            { rawtx: ta.toHex() },
          ),
        )
      )[0],
    ).toBe(202);
    // Inside the same live quote window B is still refused, although A's row reads 'missing' (WoC lag).
    expect((await h.quote(await b.sign('theme-orders-quote', fields(b))))[1].error).toBe('slug_taken');
    // A's payment lands: one paid edition, nothing for review.
    seen.add(ta.id('hex'));
    await h.mine(await a.sign('theme-orders-mine', {}));
    expect(store.rows.map((r) => r.status)).toEqual(['paid']);
  });

  // FLIPPED by the 06c fix (L3). The reviewer's original asserted the raw code an old app shows ("update_required").
  test('old apps (no store field): 426 before anything is recorded; the body an old app shows is a plain sentence', async () => {
    const store = memStore();
    const h = tb.makeThemeBuyHandlers(deps(store));
    const u = user(401);
    const r = await h.quote(await u.sign('theme-buy-quote', { pack: 'npg' }));
    // An old app shows MESSAGES[error] ?? error: error must be the sentence itself.
    expect(r).toEqual([
      426,
      { error: 'Please update bWalletX to the latest version to buy from the Store.', code: 'update_required' },
    ]);
    expect(store.rows).toEqual([]);
    // owned is not gated: an old app still lists what it owns.
    expect((await h.owned(await u.sign('theme-buy-owned', {})))[0]).toBe(200);
  });

  test('lost outbox: a claim with no rawtx is taken only once the network has it, read back and checked against the quote', async () => {
    const store = memStore();
    const seen = new Set();
    const chain = new Map();
    const h = tb.makeThemeBuyHandlers(deps(store, seen, { fetchTx: async (t) => chain.get(t) ?? null }));
    const u = user(501);
    const [, q] = await h.quote(await u.sign('theme-buy-quote', { pack: 'npg', store: '2' }));
    const [, qOther] = await h.quote(await u.sign('theme-buy-quote', { pack: 'npgx', store: '2' }));
    const t = bareForgery(q);
    // Not on the network: 202 unverified, nothing recorded.
    const c = () => u.sign('theme-buy-claim', { quote_id: q.quote_id, txid: t.id('hex'), store: '2' });
    expect((await h.claim(await c()))[1]).toMatchObject({ pending: true, unverified: true });
    expect(store.rows[0].txid).toBeUndefined();
    seen.add(t.id('hex'));
    chain.set(t.id('hex'), t);
    expect((await h.claim(await c()))[0]).toBe(200);
    // A seen tx that pays ANOTHER quote is refused for this one.
    const wrong = await h.claim(
      await u.sign('theme-buy-claim', { quote_id: qOther.quote_id, txid: t.id('hex'), store: '2' }),
    );
    expect(wrong[0]).toBe(402);
  });

  // FLIPPED by the 06c fix (L2). The reviewer's original asserted the bug: a second quote, two $99 payments.
  test('L2 (fixed): editions: the SAME buyer gets no second quote while the first payment is pending (202)', async () => {
    NOW = 1_800_000_000_000;
    const store = memStore();
    const seen = new Set();
    const h = to.makeThemeOrderHandlers(deps(store, seen));
    const a = user(601);
    const fields = {
      slug: 'myband',
      name: 'My Band',
      brand: 'My Band',
      isBrand: '0',
      link: 'https://myband.example',
      colours: JSON.stringify(['#112233', '#445566']),
      files: JSON.stringify([{ path: `${a.identityKey}/${'b'.repeat(64)}.png`, type: 'image/png', size: 10 }]),
      note: '',
      store: '2',
    };
    const [, q1] = await h.quote(await a.sign('theme-orders-quote', fields));
    const t1 = bareForgery(q1);
    const c1 = await h.claim(
      await a.sign(
        'theme-orders-claim',
        { quote_id: q1.quote_id, txid: t1.id('hex'), store: '2' },
        { rawtx: t1.toHex() },
      ),
    );
    expect(c1[0]).toBe(202); // pending: ARC ANNOUNCED, WoC lag
    NOW += 60_000;
    expect(await h.quote(await a.sign('theme-orders-quote', fields))).toEqual([409, { error: 'payment_pending' }]);
    seen.add(t1.id('hex'));
    await h.mine(await a.sign('theme-orders-mine', {}));
    expect(store.rows.filter((r) => r.status === 'paid').length).toBe(1); // one $99 payment for one edition
  });
});
