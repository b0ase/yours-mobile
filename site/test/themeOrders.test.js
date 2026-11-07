import { describe, expect, test } from 'bun:test';
import crypto from 'crypto';
import { P2PKH, PrivateKey, ProtoWallet, Script, Transaction, Utils } from '@bsv/sdk';
import pm from '../lib/paymail.js';
import ptx from '../lib/paidTxids.js';
import pms from '../lib/paymailStore.js';
import to from '../lib/themeOrders.js';

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
  const aliases = new Map();
  return {
    rows,
    aliases,
    uploads: [],
    events: [],
    insertOrder: async (r) => (rows.push({ id: `id${rows.length}`, created_at: 'now', ...r }), rows.at(-1)),
    getByQuote: async (q) => rows.find((r) => r.quote_id === q) ?? null,
    getByTxid: async (t) => rows.find((r) => r.txid === t) ?? null,
    slugRows: async (s) => rows.filter((r) => r.slug === s && r.status !== 'declined'),
    updateOrder: async (id, p) =>
      Object.assign(
        rows.find((r) => r.id === id),
        p,
      ),
    listMine: async (k) => rows.filter((r) => r.identity_key === k && r.status !== 'quoted'),
    pendingMine: async (k) => rows.filter((r) => r.identity_key === k && r.status === 'quoted' && r.txid),
    aliasOwner: async (a) => aliases.get(a) ?? null,
    uploadFile: async function (path) {
      this.uploads.push(path);
    },
    notify: async function (kind, payload) {
      this.events.push({ kind, payload });
    },
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
  const h = to.makeThemeOrderHandlers({
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

const formFor = (identityKey, over = {}) => ({
  slug: 'vexvoid',
  name: 'Vex Void',
  brand: 'Vex Void',
  isBrand: '0',
  link: 'https://x.com/vexvoid',
  colours: JSON.stringify(['#ff0066', '#111111']),
  files: JSON.stringify([{ path: `${identityKey}/${'a'.repeat(64)}.png`, type: 'image/png', size: 1000 }]),
  note: '',
  ...over,
});

const payTx = (q, { sats = q.sats, memo = q.memo_hex, to: addr = PAY } = {}) => {
  const tx = new Transaction();
  tx.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: new Script(),
    sequence: 0xffffffff,
  });
  tx.addOutput({ lockingScript: new P2PKH().lock(addr), satoshis: sats });
  if (memo) tx.addOutput({ lockingScript: Script.fromHex(memo), satoshis: 0 });
  return tx;
};

describe('validateOrder', () => {
  const k = user().identityKey;
  test('accepts a good form and normalises it', () => {
    const v = to.validateOrder(formFor(k, { colours: JSON.stringify(['#FF0066', '#111111', '#eeeeee']) }), k);
    expect(v.ok).toBe(true);
    expect(v.order.colours).toEqual(['#ff0066', '#111111', '#eeeeee']);
    expect(v.order.links).toEqual(['https://x.com/vexvoid']);
  });
  test.each([
    [{ slug: 'ab' }, 'slug'],
    [{ slug: '-bad-' }, 'slug'],
    [{ slug: 'Custom' }, 'slug_reserved'],
    [{ name: 'x' }, 'name'],
    [{ brand: '' }, 'brand'],
    [{ link: 'http://127.0.0.1/' }, 'link'],
    [{ link: 'javascript:alert(1)' }, 'link'],
    [{ colours: JSON.stringify(['#fff']) }, 'colours'],
    [{ colours: JSON.stringify(['#ff0066', 'red']) }, 'colours'],
    [{ files: '[]' }, 'files'],
    [
      { files: JSON.stringify([{ path: `${'0'.repeat(66)}/${'a'.repeat(64)}.png`, type: 'image/png', size: 1 }]) },
      'files',
    ],
    [{ files: JSON.stringify([{ path: `X/${'a'.repeat(64)}.png`, type: 'image/jpeg', size: 1 }]) }, 'files'],
    [{ note: 'n'.repeat(501) }, 'note'],
    [{ isBrand: '1' }, 'proof'],
  ])('refuses %j', (over, code) => {
    const v = to.validateOrder(formFor(k, over), k);
    expect(v.ok).toBe(false);
    expect(v.error.startsWith(code)).toBe(true);
  });
});

describe('quote', () => {
  test('503 not_configured without THEME_ORDER_PAY_ADDRESS (no fake payment)', async () => {
    const { h } = setup({});
    const u = user();
    expect(await h.quote(await u.sign('theme-orders-quote', formFor(u.identityKey)))).toEqual([
      503,
      { error: 'not_configured' },
    ]);
  });

  test('returns outputs, memo and the $99 price at the feed rate', async () => {
    const { h, store } = setup();
    const u = user();
    const [st, q] = await h.quote(await u.sign('theme-orders-quote', formFor(u.identityKey)));
    expect(st).toBe(200);
    expect(q.usd).toBe(99);
    expect(q.sats).toBe(198_000_000); // $99 at $50/BSV
    expect(q.outputs).toEqual([{ script: new P2PKH().lock(PAY).toHex(), satoshis: q.sats }]);
    expect(q.memo_hex).toBe(to.memoScript(q.quote_id).toHex());
    expect(Date.parse(q.expires_at)).toBe(NOW + to.QUOTE_MS);
    expect(store.rows[0].status).toBe('quoted');
  });

  test('rejects a bad signature and a tampered field', async () => {
    const { h } = setup();
    const u = user();
    const body = await u.sign('theme-orders-quote', formFor(u.identityKey));
    expect((await h.quote({ ...body, fields: { ...body.fields, slug: 'other' } }))[0]).toBe(401);
  });

  test('slug held by another wallet → 409 slug_taken; same wallet may re-quote', async () => {
    const { h } = setup();
    const a = user(1);
    const b = user(2);
    expect((await h.quote(await a.sign('theme-orders-quote', formFor(a.identityKey))))[0]).toBe(200);
    expect(await h.quote(await b.sign('theme-orders-quote', formFor(b.identityKey)))).toEqual([
      409,
      { error: 'slug_taken' },
    ]);
    expect((await h.quote(await a.sign('theme-orders-quote', formFor(a.identityKey))))[0]).toBe(200);
  });

  test('brand proof must be a name on this wallet', async () => {
    const { h, store } = setup();
    const u = user();
    const form = formFor(u.identityKey, {
      isBrand: '1',
      proof: JSON.stringify({ kind: 'paymail', value: 'vexvoid.x' }),
    });
    expect((await h.quote(await u.sign('theme-orders-quote', form)))[0]).toBe(403);
    store.aliases.set('vexvoid.x', u.identityKey);
    expect((await h.quote(await u.sign('theme-orders-quote', form)))[0]).toBe(200);
    expect(store.rows[0].proof).toEqual({ kind: 'paymail', value: 'vexvoid.x' });
  });
});

describe('claim', () => {
  const quoted = async () => {
    const s = setup();
    const u = user();
    const [, q] = await s.h.quote(await u.sign('theme-orders-quote', formFor(u.identityKey)));
    return { ...s, u, q };
  };
  const claimBody = (u, q, tx) =>
    u.sign('theme-orders-claim', { quote_id: q.quote_id, txid: tx.id('hex') }, { rawtx: tx.toHex() });

  test('verifies outputs + memo, broadcasts, records paid and notifies', async () => {
    const { h, u, q, store, broadcasts } = await quoted();
    const tx = payTx(q);
    const [st, out] = await h.claim(await claimBody(u, q, tx));
    expect(st).toBe(200);
    expect(out.order.status).toBe('paid');
    expect(broadcasts).toEqual([tx.id('hex')]);
    expect(store.rows[0].txid).toBe(tx.id('hex'));
    expect(Date.parse(store.rows[0].expires_at)).toBe(NOW + 365 * 86_400_000);
    expect(store.events[0].kind).toBe('theme_order_paid');
    // A retry of the same claim is fine; the order shows in mine.
    expect((await h.claim(await claimBody(u, q, tx)))[0]).toBe(200);
    const [, m] = await h.mine(await u.sign('theme-orders-mine'));
    expect(m.orders.map((o) => o.slug)).toEqual(['vexvoid']);
  });

  test('underpaid, missing memo, wrong address, wrong txid', async () => {
    const { h, u, q, store } = await quoted();
    expect((await h.claim(await claimBody(u, q, payTx(q, { sats: q.sats - 1 }))))[1].error).toBe('underpaid');
    expect((await h.claim(await claimBody(u, q, payTx(q, { memo: null }))))[1].error).toBe('memo_missing');
    const other = to.memoScript('f'.repeat(32)).toHex();
    expect((await h.claim(await claimBody(u, q, payTx(q, { memo: other }))))[1].error).toBe('memo_missing');
    const wrongTo = new PrivateKey(9).toPublicKey().toAddress();
    expect((await h.claim(await claimBody(u, q, payTx(q, { to: wrongTo }))))[1].error).toBe('underpaid');
    const tx = payTx(q);
    const body = await u.sign(
      'theme-orders-claim',
      { quote_id: q.quote_id, txid: 'ab'.repeat(32) },
      { rawtx: tx.toHex() },
    );
    expect((await h.claim(body))[1].error).toBe('txid_mismatch');
    expect(store.rows[0].status).toBe('quoted');
  });

  test("another wallet can't claim the quote; ARC refused and nobody has it: 502, not paid, then let go", async () => {
    const { h, q, store, net } = await quoted();
    const tx = payTx(q);
    const thief = user(5);
    expect((await h.claim(await claimBody(thief, q, tx)))[0]).toBe(404);
    net.arc = 'REJECTED';
    net.status = 'missing';
    const u = user();
    const [st, out] = await h.claim(await claimBody(u, q, tx));
    expect(st).toBe(502);
    expect(out.error).toBe('broadcast_failed');
    expect(store.rows[0].status).toBe('quoted');
    // The txid stays on the row (pending) until the payment is shown never to have reached the network.
    expect(store.rows[0].txid).toBe(tx.id('hex'));
    SIGN_AT.t = net.now = NOW + 15 * 60_000 + 61 * 60_000;
    await h.mine(await u.sign('theme-orders-mine'));
    expect(store.rows[0].txid).toBeNull();
    expect(store.rows[0].status).toBe('quoted');
  });

  test('ANNOUNCED is not paid: 202 pending, the slug is held, and mine marks it paid once the network has it', async () => {
    const { h, u, q, store, net } = await quoted();
    net.arc = 'ANNOUNCED_TO_NETWORK';
    net.status = 'out';
    const tx = payTx(q);
    const [st, out] = await h.claim(await claimBody(u, q, tx));
    expect(st).toBe(202);
    expect(out.pending).toBe(true);
    expect(out.status).toBe('ANNOUNCED_TO_NETWORK');
    expect(store.rows[0].status).toBe('quoted');
    expect(store.rows[0].txid).toBe(tx.id('hex'));
    expect(store.events).toEqual([]);
    // Another payer can't take the slug while this payment is pending, even after the quote ran out.
    SIGN_AT.t = net.now = NOW + 20 * 60_000;
    const other = user(9);
    expect((await h.quote(await other.sign('theme-orders-quote', formFor(other.identityKey))))[1].error).toBe(
      'slug_taken',
    );
    net.status = 'seen';
    const [, m] = await h.mine(await u.sign('theme-orders-mine'));
    expect(m.orders.map((o) => [o.slug, o.status])).toEqual([['vexvoid', 'paid']]);
    expect(store.events[0].kind).toBe('theme_order_paid');
  });

  test('a payment that matches is honoured after the quote ran out (owner, 3 Nov 2026)', async () => {
    const { h, u, q, store, net } = await quoted();
    SIGN_AT.t = net.now = NOW + 3 * 24 * 60 * 60_000;
    const [st, out] = await h.claim(await claimBody(u, q, payTx(q)));
    expect(st).toBe(200);
    expect(out.order.status).toBe('paid');
    expect(store.rows[0].status).toBe('paid');
  });

  test('the txid is on the row before ARC is called', async () => {
    SIGN_AT.t = NOW;
    const store = memStore();
    let atBroadcast;
    const h = to.makeThemeOrderHandlers({
      store,
      ledger: ptx.memoryPaidTxids(),
      rate: async () => 50,
      broadcast: async (tx) => {
        atBroadcast = store.rows[0].txid;
        expect(atBroadcast).toBe(tx.id('hex'));
        return { txStatus: 'SEEN_ON_NETWORK', accepted: true };
      },
      network: async () => 'unclear',
      env: { THEME_ORDER_PAY_ADDRESS: PAY },
      now: () => NOW,
      log: () => undefined,
    });
    const u = user();
    const [, q] = await h.quote(await u.sign('theme-orders-quote', formFor(u.identityKey)));
    const tx = payTx(q);
    expect((await h.claim(await claimBody(u, q, tx)))[0]).toBe(200);
    expect(atBroadcast).toBe(tx.id('hex'));
  });
});

describe('upload', () => {
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]);
  const body = (u, bytes, type) =>
    u.sign(
      'theme-orders-upload',
      { type, sha256: crypto.createHash('sha256').update(bytes).digest('hex') },
      { data: bytes.toString('base64') },
    );
  test('stores a PNG under the wallet folder', async () => {
    const { h, store } = setup();
    const u = user();
    const [st, out] = await h.upload(await body(u, png, 'image/png'));
    expect(st).toBe(200);
    expect(out.path.startsWith(`${u.identityKey}/`)).toBe(true);
    expect(store.uploads).toEqual([out.path]);
  });
  test('refuses wrong magic bytes, scripted SVG and over 2 MB', async () => {
    const { h } = setup();
    const u = user();
    expect((await h.upload(await body(u, png, 'image/jpeg')))[0]).toBe(400);
    expect((await h.upload(await body(u, Buffer.from('<svg onload="x()"></svg>'), 'image/svg+xml')))[0]).toBe(400);
    expect((await h.upload(await body(u, Buffer.alloc(2 * 1024 * 1024 + 1), 'image/png')))[0]).toBe(413);
  });
});
