import { describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, ProtoWallet, Script, Transaction, Utils } from '@bsv/sdk';
import pm from '../lib/paymail.js';
import ptx from '../lib/paidTxids.js';
import pms from '../lib/paymailStore.js';
import tb from '../lib/themeBuys.js';

const NOW = 1_800_000_000_000;
const PAY = new PrivateKey(7).toPublicKey().toAddress();
/** The clock requests are signed at (tests that move the server's clock move this with it). */
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

const memStore = () => {
  const rows = [];
  return {
    rows,
    insert: async (r) => (rows.push({ id: `id${rows.length}`, ...r }), rows.at(-1)),
    getByQuote: async (q) => rows.find((r) => r.quote_id === q) ?? null,
    getByTxid: async (t) => rows.find((r) => r.txid === t) ?? null,
    update: async (id, p) =>
      Object.assign(
        rows.find((r) => r.id === id),
        p,
      ),
    owned: async (k) => rows.filter((r) => r.identity_key === k && r.status === 'paid'),
    pending: async (k) => rows.filter((r) => r.identity_key === k && r.status === 'quoted' && r.txid).reverse(),
  };
};

// net.arc: what ARC answers the claim's post; net.status: networkStatus (paymailStore.js) for any txid; net.now: the clock.
const setup = (
  env = { THEME_ORDER_PAY_ADDRESS: PAY },
  net = { arc: 'SEEN_ON_NETWORK', status: 'unclear', now: NOW },
) => {
  SIGN_AT.t = NOW;
  const store = memStore();
  const broadcasts = [];
  const h = tb.makeThemeBuyHandlers({
    store,
    ledger: ptx.memoryPaidTxids(),
    rate: async () => 50,
    broadcast: async (tx) => {
      broadcasts.push(tx.id('hex'));
      const refused = /REJECTED/.test(net.arc);
      return { txStatus: net.arc, accepted: !refused && pms.ARC_ACCEPTED.has(net.arc), refused };
    },
    network: async () => net.status,
    env,
    now: () => net.now ?? NOW,
    log: () => undefined,
  });
  return { store, h, broadcasts, net };
};
/** Move the server's clock and the signing clock together. */
const at = (net, t) => {
  SIGN_AT.t = net.now = t;
};

const payTx = (q, { sats = q.sats, memo = q.memo_hex, to: addr = PAY, n = 0 } = {}) => {
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: n,
    unlockingScript: new Script(),
    sequence: 0xffffffff,
  });
  tx.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: sats });
  if (memo) tx.addOutput({ lockingScript: Script.fromHex(memo), satoshis: 0 });
  return tx;
};

const claimBody = (u, q, tx) =>
  u.sign('theme-buy-claim', { quote_id: q.quote_id, txid: tx.id('hex') }, { rawtx: tx.toHex() });

describe('theme buys', () => {
  test('503 not_configured without a pay address (no fake payment)', async () => {
    const { h } = setup({});
    const u = user();
    expect(await h.quote(await u.sign('theme-buy-quote', { pack: 'vexvoid' }))).toEqual([
      503,
      { error: 'not_configured' },
    ]);
  });

  test('only the listed packs are for sale, at $1', async () => {
    const { h } = setup();
    const u = user();
    expect((await h.quote(await u.sign('theme-buy-quote', { pack: 'gold' })))[0]).toBe(404);
    const [s, q] = await h.quote(await u.sign('theme-buy-quote', { pack: 'npgx' }));
    expect(s).toBe(200);
    expect(q.usd).toBe(1);
    expect(q.sats).toBe(2_000_000 - 500); // $1 at $50/BSV, less room for the network fee
  });

  test('a matching payment is broadcast and the pack is owned; a retry is idempotent', async () => {
    const { h, broadcasts } = setup();
    const u = user();
    const [, q] = await h.quote(await u.sign('theme-buy-quote', { pack: 'vexvoid' }));
    const tx = payTx(q);
    expect(await h.claim(await claimBody(u, q, tx))).toEqual([200, { pack: 'vexvoid', txid: tx.id('hex') }]);
    expect(broadcasts).toEqual([tx.id('hex')]);
    expect((await h.claim(await claimBody(u, q, tx)))[0]).toBe(200);
    expect(broadcasts.length).toBe(1);
    const [, o] = await h.owned(await u.sign('theme-buy-owned'));
    expect(o.packs).toEqual(['vexvoid']);
    expect((await h.quote(await u.sign('theme-buy-quote', { pack: 'vexvoid' })))[1]).toEqual({
      error: 'already_owned',
    });
  });

  test('underpaid, wrong address or missing memo: nothing recorded, nothing broadcast', async () => {
    const { h, broadcasts } = setup();
    const u = user();
    for (const bad of [{ sats: 1 }, { to: new PrivateKey(9).toPublicKey().toAddress() }, { memo: null }]) {
      const [, q] = await h.quote(await u.sign('theme-buy-quote', { pack: 'npg' }));
      const [s] = await h.claim(await claimBody(u, q, payTx(q, bad)));
      expect(s).toBe(402);
    }
    expect(broadcasts).toEqual([]);
    expect((await h.owned(await u.sign('theme-buy-owned')))[1].packs).toEqual([]);
  });

  test("someone else's quote is not found", async () => {
    const { h } = setup();
    const a = user(1);
    const b = user(2);
    const [, q] = await h.quote(await a.sign('theme-buy-quote', { pack: 'npg' }));
    expect((await h.claim(await claimBody(b, q, payTx(q))))[0]).toBe(404);
  });

  test('ANNOUNCED is not paid (5916dd14): 202 pending, not owned, no second quote, owned marks it paid once seen', async () => {
    const { h, store, net } = setup();
    net.arc = 'ANNOUNCED_TO_NETWORK';
    net.status = 'out';
    const u = user();
    const [, q] = await h.quote(await u.sign('theme-buy-quote', { pack: 'emoji-cool' }));
    const tx = payTx(q);
    const [st, out] = await h.claim(await claimBody(u, q, tx));
    expect(st).toBe(202);
    expect(out).toMatchObject({
      pack: 'emoji-cool',
      txid: tx.id('hex'),
      pending: true,
      status: 'ANNOUNCED_TO_NETWORK',
    });
    expect(store.rows[0].status).toBe('quoted');
    expect(store.rows[0].txid).toBe(tx.id('hex'));
    expect((await h.owned(await u.sign('theme-buy-owned')))[1].packs).toEqual([]);
    // No second payment for the pack while this one is on its way.
    expect((await h.quote(await u.sign('theme-buy-quote', { pack: 'emoji-cool' })))[1]).toEqual({
      error: 'payment_pending',
    });
    // A retry still pending; another tx for the same quote is refused.
    expect((await h.claim(await claimBody(u, q, tx)))[0]).toBe(202);
    expect(
      (await h.claim(await claimBody(u, q, payTx(q, { sats: q.sats, memo: q.memo_hex, to: PAY, n: 2 }))))[1],
    ).toEqual({
      error: 'payment_pending',
    });
    // The network has it now: owned marks it paid.
    net.status = 'seen';
    expect((await h.owned(await u.sign('theme-buy-owned')))[1].packs).toEqual(['emoji-cool']);
    expect(store.rows[0].status).toBe('paid');
  });

  test('ANNOUNCED at ARC but WhatsOnChain has it: paid', async () => {
    const { h, net } = setup();
    net.arc = 'ANNOUNCED_TO_NETWORK';
    net.status = 'seen';
    const u = user();
    const [, q] = await h.quote(await u.sign('theme-buy-quote', { pack: 'npg' }));
    const tx = payTx(q);
    expect(await h.claim(await claimBody(u, q, tx))).toEqual([200, { pack: 'npg', txid: tx.id('hex') }]);
  });

  test('paid only on SEEN, ACCEPTED or MINED: every other ARC answer is pending', async () => {
    for (const arc of [
      'QUEUED',
      'RECEIVED',
      'STORED',
      'ANNOUNCED_TO_NETWORK',
      'SENT_TO_NETWORK',
      'SEEN_IN_ORPHAN_MEMPOOL',
      '',
    ]) {
      const { h, store, net } = setup();
      net.arc = arc;
      const u = user();
      const [, q] = await h.quote(await u.sign('theme-buy-quote', { pack: 'npg' }));
      expect((await h.claim(await claimBody(u, q, payTx(q))))[0]).toBe(202);
      expect(store.rows[0].status).toBe('quoted');
    }
    for (const arc of ['SEEN_ON_NETWORK', 'SEEN_MULTIPLE_NODES', 'ACCEPTED_BY_NETWORK', 'MINED']) {
      const { h, store, net } = setup();
      net.arc = arc;
      const u = user();
      const [, q] = await h.quote(await u.sign('theme-buy-quote', { pack: 'npg' }));
      expect((await h.claim(await claimBody(u, q, payTx(q))))[0]).toBe(200);
      expect(store.rows[0].status).toBe('paid');
    }
  });

  test('the txid is on the row before ARC is called (no second payment on a timeout)', async () => {
    const store = memStore();
    SIGN_AT.t = NOW;
    let seenAtBroadcast = null;
    const h = tb.makeThemeBuyHandlers({
      store,
      ledger: ptx.memoryPaidTxids(),
      rate: async () => 50,
      broadcast: async () => {
        seenAtBroadcast = store.rows[0].txid;
        return { txStatus: '', accepted: false, refused: false, error: 'timeout' };
      },
      network: async () => 'unclear',
      env: { THEME_ORDER_PAY_ADDRESS: PAY },
      now: () => NOW,
      log: () => undefined,
    });
    const u = user();
    const [, q] = await h.quote(await u.sign('theme-buy-quote', { pack: 'npg' }));
    const tx = payTx(q);
    expect((await h.claim(await claimBody(u, q, tx)))[0]).toBe(202);
    expect(seenAtBroadcast).toBe(tx.id('hex'));
    // The quote can't be paid again with another tx while this one is pending.
    expect((await h.quote(await u.sign('theme-buy-quote', { pack: 'npg' })))[1].error).toBe('payment_pending');
  });

  test('a matching payment after the quote ran out is honoured (owner, 3 Nov 2026)', async () => {
    const { h, store, net } = setup();
    const u = user();
    const [, q] = await h.quote(await u.sign('theme-buy-quote', { pack: 'vexvoid' }));
    at(net, NOW + 2 * 24 * 60 * 60_000); // two days: past the old 24 h grace too
    const tx = payTx(q);
    expect(await h.claim(await claimBody(u, q, tx))).toEqual([200, { pack: 'vexvoid', txid: tx.id('hex') }]);
    expect(store.rows[0].status).toBe('paid');
  });

  test('a pending payment that never reached the network is let go, so the pack can be bought again', async () => {
    const { h, store, net } = setup();
    net.arc = 'REJECTED';
    net.status = 'missing';
    const u = user();
    const [, q] = await h.quote(await u.sign('theme-buy-quote', { pack: 'npgx' }));
    const tx = payTx(q);
    const [st, out] = await h.claim(await claimBody(u, q, tx));
    expect(st).toBe(502);
    expect(out.error).toBe('broadcast_failed');
    expect(store.rows[0].status).toBe('quoted');
    // Within the hour after the quote: still held (it might be slow, like 5916dd14's 16 minutes).
    at(net, NOW + 15 * 60_000 + 30 * 60_000);
    expect((await h.quote(await u.sign('theme-buy-quote', { pack: 'npgx' })))[1].error).toBe('payment_pending');
    // An hour past the quote and nobody has it: let go.
    at(net, NOW + 15 * 60_000 + 61 * 60_000);
    const [s2] = await h.quote(await u.sign('theme-buy-quote', { pack: 'npgx' }));
    expect(s2).toBe(200);
    expect(store.rows[0].txid).toBeNull();
    // If it shows up after all, a claim retry records and honours it.
    net.status = 'seen';
    net.arc = 'MINED';
    expect(await h.claim(await claimBody(u, q, tx))).toEqual([200, { pack: 'npgx', txid: tx.id('hex') }]);
  });

  test('"unclear" (ARC and WhatsOnChain unreachable) never lets a pending payment go', async () => {
    const { h, store, net } = setup();
    net.arc = 'ANNOUNCED_TO_NETWORK';
    net.status = 'unclear';
    const u = user();
    const [, q] = await h.quote(await u.sign('theme-buy-quote', { pack: 'npg' }));
    const tx = payTx(q);
    expect((await h.claim(await claimBody(u, q, tx)))[0]).toBe(202);
    at(net, NOW + 30 * 24 * 60 * 60_000);
    expect((await h.quote(await u.sign('theme-buy-quote', { pack: 'npg' })))[1].error).toBe('payment_pending');
    expect(store.rows[0].txid).toBe(tx.id('hex'));
  });
});

/**
 * b-Aware, shdx (29 Oct 2026): a quote taken before the pack was bought stayed payable after it was owned, so the
 * same buyer could be charged twice for one pack (two devices, a double tap, a retry, or the agent API). The quote
 * refused a second quote, but the claim never looked again. The claim now refuses, before any txid is recorded and
 * before the wallet is told to broadcast (claim intent), when this buyer already owns the pack or has another
 * payment for it on its way.
 */
describe('shdx: one pack, one payment', () => {
  const intentBody = (u, q, tx) =>
    u.sign('theme-buy-claim', { quote_id: q.quote_id, txid: tx.id('hex'), intent: '1' }, { rawtx: tx.toHex() });

  test('a second quote taken before the first was paid: its claim intent is refused once the pack is owned', async () => {
    const { h, store, broadcasts } = setup();
    const u = user();
    const [, qa] = await h.quote(await u.sign('theme-buy-quote', { pack: 'vexvoid' }));
    const [, qb] = await h.quote(await u.sign('theme-buy-quote', { pack: 'vexvoid' }));
    const txb = payTx(qb);
    expect((await h.claim(await claimBody(u, qb, txb)))[0]).toBe(200);
    const txa = payTx(qa, { n: 1 });
    // The wallet asks before it broadcasts: refused, so it releases the payment unsent.
    expect(await h.claim(await intentBody(u, qa, txa))).toEqual([409, { error: 'already_owned' }]);
    // A claim without intent (a payer that only signed) is refused too: nothing broadcast, nothing recorded.
    expect(await h.claim(await claimBody(u, qa, txa))).toEqual([409, { error: 'already_owned' }]);
    expect(broadcasts).toEqual([txb.id('hex')]);
    const rowA = store.rows.find((r) => r.quote_id === qa.quote_id);
    expect(rowA.txid ?? null).toBeNull();
    expect(rowA.status).toBe('quoted');
    expect(store.rows.filter((r) => r.status === 'paid').length).toBe(1);
  });

  test('two quotes paid one after the other while the first is on its way: the second is refused', async () => {
    const { h, store, net } = setup();
    net.arc = 'ANNOUNCED_TO_NETWORK';
    net.status = 'out';
    const u = user();
    const [, qa] = await h.quote(await u.sign('theme-buy-quote', { pack: 'npg' }));
    const [, qb] = await h.quote(await u.sign('theme-buy-quote', { pack: 'npg' }));
    const txa = payTx(qa);
    expect((await h.claim(await intentBody(u, qa, txa)))[0]).toBe(202);
    const txb = payTx(qb, { n: 1 });
    expect(await h.claim(await intentBody(u, qb, txb))).toEqual([409, { error: 'payment_pending' }]);
    expect(store.rows.find((r) => r.quote_id === qb.quote_id).txid ?? null).toBeNull();
    // The first goes through as before.
    expect((await h.claim(await claimBody(u, qa, txa)))[0]).toBe(202);
  });

  test('another buyer, or another pack, is not affected', async () => {
    const { h } = setup();
    const a = user(1);
    const b = user(2);
    const [, qa] = await h.quote(await a.sign('theme-buy-quote', { pack: 'npgx' }));
    const [, qb] = await h.quote(await b.sign('theme-buy-quote', { pack: 'npgx' }));
    const [, qa2] = await h.quote(await a.sign('theme-buy-quote', { pack: 'npg' }));
    expect((await h.claim(await claimBody(a, qa, payTx(qa))))[0]).toBe(200);
    expect((await h.claim(await claimBody(b, qb, payTx(qb, { n: 1 }))))[0]).toBe(200);
    expect((await h.claim(await claimBody(a, qa2, payTx(qa2, { n: 2 }))))[0]).toBe(200);
  });

  test('two claim intents at the same moment: never both told to broadcast', async () => {
    const store = memStore();
    // Both txid writes land before either claim reads again (PostgREST: two requests in flight).
    let waiting = [];
    const update = store.update;
    store.update = async (id, p) => {
      if (p && typeof p.txid === 'string') {
        await new Promise((ok) => {
          waiting.push(ok);
          if (waiting.length === 2) {
            for (const w of waiting) w();
            waiting = [];
          }
        });
      }
      return update(id, p);
    };
    SIGN_AT.t = NOW;
    const broadcasts = [];
    const h = tb.makeThemeBuyHandlers({
      store,
      ledger: ptx.memoryPaidTxids(),
      rate: async () => 50,
      broadcast: async (tx) => (broadcasts.push(tx.id('hex')), { txStatus: 'SEEN_ON_NETWORK', accepted: true }),
      network: async () => 'out',
      env: { THEME_ORDER_PAY_ADDRESS: PAY },
      now: () => NOW,
      log: () => undefined,
    });
    const u = user();
    const [, qa] = await h.quote(await u.sign('theme-buy-quote', { pack: 'tokenblaster' }));
    const [, qb] = await h.quote(await u.sign('theme-buy-quote', { pack: 'tokenblaster' }));
    const answers = await Promise.all([
      h.claim(await intentBody(u, qa, payTx(qa))),
      h.claim(await intentBody(u, qb, payTx(qb, { n: 1 }))),
    ]);
    const told = answers.filter(([s]) => s === 202);
    expect(told.length).toBeLessThanOrEqual(1);
    for (const [s, body] of answers) if (s !== 202) expect(body.error).toBe('payment_pending');
    // A refused claim leaves its quote with no txid, so the buyer can try again.
    const withTxid = store.rows.filter((r) => r.txid);
    expect(withTxid.length).toBe(told.length);
    expect(broadcasts).toEqual([]);
  });
});
