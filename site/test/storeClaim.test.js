// Review 4 Nov 2026 (06b): the Store claim's server rules beyond "paid only when seen" (storeClaim.js).
import { describe, expect, test } from 'bun:test';
import { Beef, MerklePath, P2PKH, PrivateKey, ProtoWallet, Script, Transaction, Utils } from '@bsv/sdk';
import pm from '../lib/paymail.js';
import ptx from '../lib/paidTxids.js';
import pms from '../lib/paymailStore.js';
import tb from '../lib/themeBuys.js';
import to from '../lib/themeOrders.js';
import td from '../lib/themeDeposits.js';

const NOW = 1_800_000_000_000;
const PAY = new PrivateKey(7).toPublicKey().toAddress();
const SIGN_AT = { t: NOW };

const user = (n = 42) => {
  const priv = new PrivateKey(n);
  const wallet = new ProtoWallet(priv);
  const identityKey = priv.toPublicKey().toString();
  const sign = async (action, fields = {}, extra = {}) => {
    const all = { ...fields, identityKey, timestamp: String(SIGN_AT.t) };
    const { signature } = await wallet.createSignature({
      data: Utils.toArray(pm.signedMessage(action, all), 'utf8'),
      protocolID: pm.SIGN_PROTOCOL,
      keyID: pm.SIGN_KEY_ID,
      counterparty: 'anyone',
    });
    return { identityKey, timestamp: SIGN_AT.t, fields, signature: Utils.toHex(signature), ...extra };
  };
  return { identityKey, sign };
};

/** A table store shaped like the Supabase ones, with the conditional txid write (txid=is.null). */
const memStore = (names = { insert: 'insert', update: 'update' }) => {
  const rows = [];
  const events = [];
  const s = {
    rows,
    events,
    // A snapshot, as PostgREST returns: two claims racing both read the row before either writes.
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
    slugRows: async (slug) => rows.filter((r) => r.slug === slug && r.status !== 'declined'),
    aliasOwner: async () => null,
    notify: async (kind, payload) => void events.push({ kind, payload }),
  };
  s[names.insert] = async (r) => (rows.push({ id: `id${rows.length}`, created_at: 'now', ...r }), rows.at(-1));
  s[names.update] = async (id, p) =>
    Object.assign(
      rows.find((r) => r.id === id),
      p,
    );
  return s;
};

const netModel = (over = {}) => ({ arc: 'SEEN_ON_NETWORK', status: 'unclear', now: NOW, ...over });
const deps = (net, store, extra = {}) => {
  const broadcasts = [];
  return {
    broadcasts,
    d: {
      store,
      ledger: ptx.memoryPaidTxids(),
      rate: async () => 50,
      broadcast: async (tx) => {
        broadcasts.push(tx.id('hex'));
        const refused = /REJECTED/.test(net.arc);
        return { txStatus: net.arc, accepted: !refused && pms.ARC_ACCEPTED.has(net.arc), refused };
      },
      network: async () => net.status,
      env: { THEME_ORDER_PAY_ADDRESS: PAY, THEME_DEPOSIT_USD: '999' },
      now: () => net.now,
      log: () => undefined,
      ...extra,
    },
  };
};

const payTx = (q, { n = 0 } = {}) => {
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: n,
    unlockingScript: new Script(),
    sequence: 0xffffffff,
  });
  tx.addOutput({ lockingScript: new P2PKH().lock(PAY), satoshis: q.sats });
  tx.addOutput({ lockingScript: Script.fromHex(q.memo_hex), satoshis: 0 });
  return tx;
};

/** A payment with its parent in an AtomicBEEF, signed by `signer` (the coin's own key, or a wrong one). */
const beefPay = async (q, { signer } = {}) => {
  const owner = new PrivateKey(1234);
  const parent = new Transaction();
  parent.addInput({
    sourceTXID: '11'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: new Script(),
    sequence: 0xffffffff,
  });
  parent.addOutput({ lockingScript: new P2PKH().lock(owner.toAddress()), satoshis: q.sats + 1000 });
  parent.merklePath = new MerklePath(900000, [[{ offset: 0, hash: parent.id('hex'), txid: true }]]);
  const child = new Transaction();
  child.addInput({
    sourceTransaction: parent,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(signer ?? owner),
  });
  child.addOutput({ lockingScript: new P2PKH().lock(PAY), satoshis: q.sats });
  child.addOutput({ lockingScript: Script.fromHex(q.memo_hex), satoshis: 0 });
  await child.sign();
  const beef = new Beef();
  beef.mergeTransaction(parent);
  beef.mergeTransaction(child);
  return { child, hex: Buffer.from(beef.toBinaryAtomic(child.id('hex'))).toString('hex') };
};

const claimBody = (u, q, txid, extra = {}, fields = {}) =>
  u.sign('theme-buy-claim', { quote_id: q.quote_id, txid, ...fields }, extra);

describe('claim intent: the Store knows the txid before the wallet broadcasts (F2)', () => {
  test('an intent records the txid, posts nothing, answers 202; the claim after the broadcast resumes and pays', async () => {
    SIGN_AT.t = NOW;
    const net = netModel({ status: 'unclear' });
    const store = memStore();
    const { d, broadcasts } = deps(net, store);
    const h = tb.makeThemeBuyHandlers(d);
    const u = user();
    const [, q] = await h.quote(await u.sign('theme-buy-quote', { pack: 'npg' }));
    const tx = payTx(q);
    const [st, out] = await h.claim(await claimBody(u, q, tx.id('hex'), { rawtx: tx.toHex() }, { intent: '1' }));
    expect(st).toBe(202);
    expect(out).toMatchObject({ pending: true, intent: true, txid: tx.id('hex') });
    expect(broadcasts).toEqual([]);
    expect(store.rows[0].txid).toBe(tx.id('hex'));
    expect(store.rows[0].status).toBe('quoted');
    // The pack can't be quoted again while that payment is out.
    expect((await h.quote(await u.sign('theme-buy-quote', { pack: 'npg' })))[1].error).toBe('payment_pending');
    // The wallet broadcast it and claims: the server re-posts and pays once seen.
    const [st2] = await h.claim(await claimBody(u, q, tx.id('hex'), { rawtx: tx.toHex() }));
    expect(st2).toBe(200);
    expect(broadcasts).toEqual([tx.id('hex')]);
    expect(store.rows[0].status).toBe('paid');
  });

  test('the device lost everything after the broadcast: owned alone marks it paid once the network has it', async () => {
    SIGN_AT.t = NOW;
    const net = netModel({ status: 'unclear' });
    const store = memStore();
    const { d } = deps(net, store);
    const h = tb.makeThemeBuyHandlers(d);
    const u = user();
    const [, q] = await h.quote(await u.sign('theme-buy-quote', { pack: 'npgx' }));
    const tx = payTx(q);
    await h.claim(await claimBody(u, q, tx.id('hex'), { rawtx: tx.toHex() }, { intent: '1' }));
    net.status = 'seen';
    expect((await h.owned(await u.sign('theme-buy-owned')))[1].packs).toEqual(['npgx']);
  });

  test('a claim without rawtx (the wallet lost its copy) is taken once the network has it, read back from it', async () => {
    SIGN_AT.t = NOW;
    const net = netModel({ status: 'unclear' });
    const store = memStore();
    /** What WhatsOnChain would return for the paid txid (set once the payment exists). */
    const onChain = { tx: null };
    const { d } = deps(net, store, {
      fetchTx: async (t) => (onChain.tx && t === onChain.tx.id('hex') ? onChain.tx : null),
    });
    const h = tb.makeThemeBuyHandlers(d);
    const u = user();
    const [, q] = await h.quote(await u.sign('theme-buy-quote', { pack: 'vexvoid' }));
    const tx = payTx(q);
    onChain.tx = tx;
    // Not seen yet: nothing recorded (the server can't check a tx it can't see).
    const [st, out] = await h.claim(await claimBody(u, q, tx.id('hex')));
    expect(st).toBe(202);
    expect(out.unverified).toBe(true);
    expect(store.rows[0].txid).toBeUndefined();
    net.status = 'seen';
    expect((await h.claim(await claimBody(u, q, tx.id('hex'))))[0]).toBe(200);
    expect(store.rows[0].status).toBe('paid');
    // An intent must carry the tx.
    const [, q2] = await h.quote(await u.sign('theme-buy-quote', { pack: 'npg' }));
    expect((await h.claim(await claimBody(u, q2, 'ab'.repeat(32), {}, { intent: '1' })))[1].error).toBe('rawtx');
  });
});

describe('LOW items', () => {
  test('two claims with different txids for one quote: the conditional write lets only the first through', async () => {
    SIGN_AT.t = NOW;
    const net = netModel({ arc: 'ANNOUNCED_TO_NETWORK', status: 'out' });
    const store = memStore();
    const { d } = deps(net, store);
    const h = tb.makeThemeBuyHandlers(d);
    const u = user();
    const [, q] = await h.quote(await u.sign('theme-buy-quote', { pack: 'npg' }));
    const a = payTx(q, { n: 1 });
    const b = payTx(q, { n: 2 });
    // Both read the row before either wrote: simulate by racing the two claims.
    const [ra, rb] = await Promise.all([
      h.claim(await claimBody(u, q, a.id('hex'), { rawtx: a.toHex() })),
      h.claim(await claimBody(u, q, b.id('hex'), { rawtx: b.toHex() })),
    ]);
    const statuses = [ra[0], rb[0]].sort();
    expect(statuses).toEqual([202, 409]);
    expect([a.id('hex'), b.id('hex')]).toContain(store.rows[0].txid);
  });

  test('owned / mine re-checks run in parallel inside a budget: a hung network never holds the answer', async () => {
    SIGN_AT.t = NOW;
    const net = netModel({ arc: 'ANNOUNCED_TO_NETWORK', status: 'out' });
    const store = memStore();
    const { d } = deps(net, store, { recheckBudgetMs: 50 });
    const h = tb.makeThemeBuyHandlers(d);
    const u = user();
    for (const [i, pack] of ['npg', 'npgx', 'vexvoid'].entries()) {
      const [, q] = await h.quote(await u.sign('theme-buy-quote', { pack }));
      const tx = payTx(q, { n: i });
      await h.claim(await claimBody(u, q, tx.id('hex'), { rawtx: tx.toHex() }));
    }
    let calls = 0;
    d.network = () => (calls++, new Promise(() => undefined)); // never answers
    const hung = tb.makeThemeBuyHandlers(d);
    const t0 = Date.now();
    const [st] = await hung.owned(await u.sign('theme-buy-owned'));
    expect(st).toBe(200);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(calls).toBe(3); // all three asked at once
  });

  test('the dead-payment let-go never fires while ARC still holds it ("out"), however long', async () => {
    SIGN_AT.t = NOW;
    const net = netModel({ arc: 'ANNOUNCED_TO_NETWORK', status: 'out' });
    const store = memStore();
    const { d } = deps(net, store);
    const h = tb.makeThemeBuyHandlers(d);
    const u = user();
    const [, q] = await h.quote(await u.sign('theme-buy-quote', { pack: 'npg' }));
    const tx = payTx(q);
    expect((await h.claim(await claimBody(u, q, tx.id('hex'), { rawtx: tx.toHex() })))[0]).toBe(202);
    SIGN_AT.t = net.now = NOW + 7 * 24 * 60 * 60_000;
    expect((await h.quote(await u.sign('theme-buy-quote', { pack: 'npg' })))[1].error).toBe('payment_pending');
    expect(store.rows[0].txid).toBe(tx.id('hex'));
  });

  test('a bad-signature payment (BEEF with its parent) is refused before anything is recorded; a good one pays', async () => {
    SIGN_AT.t = NOW;
    const net = netModel();
    const store = memStore();
    const { d, broadcasts } = deps(net, store);
    const h = tb.makeThemeBuyHandlers(d);
    const u = user();
    const [, q] = await h.quote(await u.sign('theme-buy-quote', { pack: 'npg' }));
    const forged = await beefPay(q, { signer: new PrivateKey(999) });
    const [st, out] = await h.claim(await claimBody(u, q, forged.child.id('hex'), { rawtx: forged.hex }));
    expect([st, out.error]).toEqual([402, 'bad_signature']);
    expect(store.rows[0].txid).toBeUndefined();
    expect(broadcasts).toEqual([]);
    const good = await beefPay(q);
    expect((await h.claim(await claimBody(u, q, good.child.id('hex'), { rawtx: good.hex })))[0]).toBe(200);
  });

  test('a pending edition holds its slug only while it may land: nobody has it → the slug is free inside the hour', async () => {
    SIGN_AT.t = NOW;
    const net = netModel({ arc: 'REJECTED', status: 'missing' });
    const store = memStore({ insert: 'insertOrder', update: 'updateOrder' });
    const { d } = deps(net, store);
    const h = to.makeThemeOrderHandlers(d);
    const squatter = user(5);
    const form = (k) => ({
      slug: 'frogcoin',
      name: 'Frog Coin',
      brand: 'Frog',
      isBrand: '0',
      link: 'https://frog.example.com',
      colours: JSON.stringify(['#7fd14a', '#0b2e12']),
      files: JSON.stringify([{ path: `${k}/${'a'.repeat(64)}.png`, type: 'image/png', size: 1000 }]),
    });
    const [, q] = await h.quote(await squatter.sign('theme-orders-quote', form(squatter.identityKey)));
    const tx = payTx(q);
    const body = await squatter.sign(
      'theme-orders-claim',
      { quote_id: q.quote_id, txid: tx.id('hex') },
      { rawtx: tx.toHex() },
    );
    expect((await h.claim(body))[0]).toBe(502);
    const buyer = user(6);
    SIGN_AT.t = net.now = NOW + 20 * 60_000; // past the quote, inside the hour
    expect((await h.quote(await buyer.sign('theme-orders-quote', form(buyer.identityKey))))[0]).toBe(200);
    // While ARC still holds it ('out'), it does hold the slug.
    const net2 = netModel({ arc: 'ANNOUNCED_TO_NETWORK', status: 'out' });
    const store2 = memStore({ insert: 'insertOrder', update: 'updateOrder' });
    const h2 = to.makeThemeOrderHandlers(deps(net2, store2).d);
    SIGN_AT.t = NOW;
    const [, q2] = await h2.quote(await squatter.sign('theme-orders-quote', form(squatter.identityKey)));
    const tx2 = payTx(q2);
    await h2.claim(
      await squatter.sign('theme-orders-claim', { quote_id: q2.quote_id, txid: tx2.id('hex') }, { rawtx: tx2.toHex() }),
    );
    SIGN_AT.t = net2.now = NOW + 20 * 60_000;
    expect((await h2.quote(await buyer.sign('theme-orders-quote', form(buyer.identityKey))))[1].error).toBe(
      'slug_taken',
    );
  });

  test('old apps (no Store protocol) are asked to update before they can quote or claim; agents are not gated', async () => {
    SIGN_AT.t = NOW;
    const net = netModel();
    const store = memStore();
    const { d } = deps(net, store);
    const inApp = tb.makeThemeBuyHandlers({ ...d, requireProtocol: true });
    const u = user();
    expect(await inApp.quote(await u.sign('theme-buy-quote', { pack: 'npg' }))).toEqual([
      426,
      // The sentence itself: an old app shows the server's `error` text as is (06c L3).
      { error: 'Please update bWalletX to the latest version to buy from the Store.', code: 'update_required' },
    ]);
    const [st, q] = await inApp.quote(await u.sign('theme-buy-quote', { pack: 'npg', store: '2' }));
    expect(st).toBe(200);
    const tx = payTx(q);
    expect((await inApp.claim(await claimBody(u, q, tx.id('hex'), { rawtx: tx.toHex() })))[0]).toBe(426);
    expect(store.rows[0].txid).toBeUndefined(); // refused before anything was recorded or broadcast
    expect((await inApp.claim(await claimBody(u, q, tx.id('hex'), { rawtx: tx.toHex() }, { store: '2' })))[0]).toBe(
      200,
    );
    // The agent / site handler sets are built without requireProtocol.
    const plain = tb.makeThemeBuyHandlers(d);
    expect((await plain.quote(await u.sign('theme-buy-quote', { pack: 'npgx' })))[0]).toBe(200);
  });

  test('deposits: a pending deposit becomes paid on the status re-check, with its notice (F6)', async () => {
    SIGN_AT.t = NOW;
    const net = netModel({ arc: 'ANNOUNCED_TO_NETWORK', status: 'out' });
    const store = memStore({ insert: 'insertDeposit', update: 'updateDeposit' });
    const { d } = deps(net, store);
    const h = td.makeThemeDepositHandlers(d);
    const u = user();
    const brief = { tier: 'branded', brand: 'Frog Coin', contact: 'team@frog.example.com' };
    const [, q] = await h.quote(await u.sign('theme-deposit-quote', brief));
    const tx = payTx(q);
    const claim = await u.sign(
      'theme-deposit-claim',
      { quote_id: q.quote_id, txid: tx.id('hex') },
      { rawtx: tx.toHex() },
    );
    expect((await h.claim(claim))[0]).toBe(202);
    const [, before] = await h.status(await u.sign('theme-deposit-status'));
    expect(before.pending.map((x) => x.txid)).toEqual([tx.id('hex')]);
    net.status = 'seen';
    const [, after] = await h.status(await u.sign('theme-deposit-status'));
    expect(after.deposits.map((x) => [x.txid, x.status])).toEqual([[tx.id('hex'), 'paid']]);
    expect(after.pending).toEqual([]);
    expect(store.events.map((e) => e.kind)).toEqual(['theme_deposit_paid']);
  });

  test('a WhatsOnChain 429 is never "missing" (networkStatus)', async () => {
    const T = 'ab'.repeat(32);
    const f = async (url) =>
      url.includes('/v1/tx/') ? new Response('{}', { status: 404 }) : new Response('rate limited', { status: 429 });
    expect(await pms.networkStatus({}, f)(T)).toBe('unclear');
  });

  test("06c L5: the edition quote re-checks the slug's pending rows in parallel inside the budget", async () => {
    SIGN_AT.t = NOW;
    const net = netModel({ arc: 'ANNOUNCED_TO_NETWORK', status: 'out' });
    const store = memStore({ insert: 'insertOrder', update: 'updateOrder' });
    const { d } = deps(net, store, { recheckBudgetMs: 50 });
    const h = to.makeThemeOrderHandlers(d);
    const form = (k) => ({
      slug: 'slowband',
      name: 'Slow Band',
      brand: 'Slow',
      isBrand: '0',
      link: 'https://slow.example.com',
      colours: JSON.stringify(['#7fd14a', '#0b2e12']),
      files: JSON.stringify([{ path: `${k}/${'a'.repeat(64)}.png`, type: 'image/png', size: 1000 }]),
    });
    // Three expired pending rows for the slug, from three other buyers (as forged intents could pile up).
    for (const n of [11, 12, 13])
      await store.insertOrder({
        identity_key: user(n).identityKey,
        slug: 'slowband',
        status: 'quoted',
        quote_id: String(n).repeat(16).slice(0, 32),
        quote_expires_at: new Date(NOW - 1).toISOString(),
        txid: String(n).padStart(2, '0').repeat(32),
      });
    let calls = 0;
    d.network = () => (calls++, new Promise(() => undefined)); // a hung network
    const h2 = to.makeThemeOrderHandlers(d);
    const buyer = user(20);
    const t0 = Date.now();
    const [st] = await h2.quote(await buyer.sign('theme-orders-quote', form(buyer.identityKey)));
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(st).toBe(409); // unknown verdicts: the pending rows still hold the slug
    expect(calls).toBe(3); // all three asked at once
    void h;
  });
});
