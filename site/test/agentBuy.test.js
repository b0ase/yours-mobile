import { describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, ProtoWallet, Script, Transaction, Utils } from '@bsv/sdk';
import pm from '../lib/paymail.js';
import ptx from '../lib/paidTxids.js';
import tb from '../lib/themeBuys.js';
import to from '../lib/themeOrders.js';
import td from '../lib/themeDeposits.js';
import ab from '../lib/agentBuy.js';

const T0 = 1_800_000_000_000;
const PAY = new PrivateKey(7).toPublicKey().toAddress();
const ENV = { THEME_ORDER_PAY_ADDRESS: PAY, THEME_DEPOSIT_USD: '250' };

const clock = { t: T0 };
const user = (n = 42) => {
  const priv = new PrivateKey(n);
  const wallet = new ProtoWallet(priv);
  const identityKey = priv.toPublicKey().toString();
  const sign = async (action, fields = {}, extra = {}) => {
    const all = { ...fields, identityKey, timestamp: String(clock.t) };
    const { signature } = await wallet.createSignature({
      data: Utils.toArray(pm.signedMessage(action, all), 'utf8'),
      protocolID: pm.SIGN_PROTOCOL,
      keyID: pm.SIGN_KEY_ID,
      counterparty: 'anyone',
    });
    return { identityKey, timestamp: clock.t, fields, signature: Utils.toHex(signature), ...extra };
  };
  return { identityKey, sign };
};

const rowsStore = (names) => {
  const rows = [];
  const s = {
    rows,
    getByQuote: async (q) => rows.find((r) => r.quote_id === q) ?? null,
    getByTxid: async (t) => rows.find((r) => r.txid === t) ?? null,
    owned: async (k) => rows.filter((r) => r.identity_key === k && r.status === 'paid'),
    slugRows: async (slug) => rows.filter((r) => r.slug === slug),
    aliasOwner: async () => null,
    notify: async () => {},
  };
  s[names.insert] = async (r) => (rows.push({ id: `id${rows.length}`, ...r }), rows.at(-1));
  s[names.update] = async (id, p) =>
    Object.assign(
      rows.find((r) => r.id === id),
      p,
    );
  return s;
};

const setup = (env = ENV) => {
  clock.t = T0;
  const broadcasts = [];
  const deps = {
    ledger: ptx.memoryPaidTxids(),
    rate: async () => 50,
    broadcast: async (tx) => broadcasts.push(tx.id('hex')),
    env,
    now: () => clock.t,
    ...ab.agentHandlerOptions(),
  };
  const h = ab.makeAgentBuyHandlers({
    buy: tb.makeThemeBuyHandlers({ store: rowsStore({ insert: 'insert', update: 'update' }), ...deps }),
    order: to.makeThemeOrderHandlers({ store: rowsStore({ insert: 'insertOrder', update: 'updateOrder' }), ...deps }),
    deposit: td.makeThemeDepositHandlers({
      store: rowsStore({ insert: 'insertDeposit', update: 'updateDeposit' }),
      ...deps,
    }),
    env,
  });
  return { h, broadcasts };
};

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

const QUOTE = 'agent-buy-quote';
const buyBody = (u, product, q, tx) =>
  u.sign('agent-buy-claim', { product, quote_id: q.quote_id, txid: tx.id('hex') }, { rawtx: tx.toHex() });

describe('agent buy', () => {
  test('products: $1 themes, $99 edition, branded from $999 with no invented price', async () => {
    const { h } = setup();
    const [, p] = await h.products();
    const themes = p.products.filter((x) => x.product === 'theme');
    expect(themes.length).toBeGreaterThanOrEqual(15);
    expect(themes.every((x) => x.usd === 1)).toBe(true);
    expect(p.products.find((x) => x.product === 'edition').usd).toBe(99);
    const b = p.products.find((x) => x.product === 'branded');
    expect(b.usd).toBe(null);
    expect(b.from_usd).toBe(999);
    expect(b.deposit_usd).toBe(250);
    expect(p.quote_ttl_seconds).toBe(300);
  });

  test('quote: USD, sats at the live rate, MNEE amount, 5-minute expiry', async () => {
    const { h } = setup();
    const u = user();
    const [s, q] = await h.quote(await u.sign(QUOTE, { product: 'theme', pack: 'vexvoid' }));
    expect(s).toBe(200);
    expect(q.product).toBe('theme');
    expect(q.usd).toBe(1);
    expect(q.sats).toBe(2_000_000 - 500);
    expect(q.mnee.amount).toBe(1);
    expect(Date.parse(q.expires_at) - T0).toBe(5 * 60 * 1000);
  });

  test('a Store-signed request is not accepted here (agent actions only)', async () => {
    const { h } = setup();
    const u = user();
    expect((await h.quote(await u.sign('theme-buy-quote', { product: 'theme', pack: 'npg' })))[0]).toBe(401);
  });

  test('buy: exact payment broadcasts once and grants the theme to the paying key', async () => {
    const { h, broadcasts } = setup();
    const u = user();
    const [, q] = await h.quote(await u.sign(QUOTE, { product: 'theme', pack: 'npgx' }));
    const tx = payTx(q);
    expect(await h.claim(await buyBody(u, 'theme', q, tx))).toEqual([
      200,
      { product: 'theme', pack: 'npgx', txid: tx.id('hex') },
    ]);
    expect(broadcasts).toEqual([tx.id('hex')]);
    expect((await h.quote(await u.sign(QUOTE, { product: 'theme', pack: 'npgx' })))[1].error).toBe('already_owned');
  });

  test('quote expiry: refused after 5 minutes plus the short grace, nothing broadcast', async () => {
    const { h, broadcasts } = setup();
    const u = user();
    const [, q] = await h.quote(await u.sign(QUOTE, { product: 'theme', pack: 'npg' }));
    clock.t = T0 + ab.AGENT_QUOTE_MS + ab.AGENT_CLAIM_GRACE_MS + 1;
    expect(await h.claim(await buyBody(u, 'theme', q, payTx(q)))).toEqual([410, { error: 'quote_expired' }]);
    expect(broadcasts).toEqual([]);
  });

  test('replay: a paid quote cannot pay again, and its tx cannot buy another quote', async () => {
    const { h, broadcasts } = setup();
    const u = user();
    const [, q1] = await h.quote(await u.sign(QUOTE, { product: 'theme', pack: 'emoji-frog' }));
    const tx1 = payTx(q1);
    expect((await h.claim(await buyBody(u, 'theme', q1, tx1)))[0]).toBe(200);
    const tx2 = payTx(q1, { sats: q1.sats }); // same quote, a second payment
    tx2.addOutput({ lockingScript: new P2PKH().lock(new PrivateKey(3).toPublicKey().toAddress()), satoshis: 5 });
    expect(await h.claim(await buyBody(u, 'theme', q1, tx2))).toEqual([409, { error: 'quote_used' }]);
    const [, q2] = await h.quote(await u.sign(QUOTE, { product: 'theme', pack: 'emoji-fire' }));
    expect((await h.claim(await buyBody(u, 'theme', q2, tx1)))[0]).toBe(402); // memo is q1's
    expect(broadcasts).toEqual([tx1.id('hex')]);
  });

  test('underpayment and wrong address are refused before broadcast', async () => {
    const { h, broadcasts } = setup();
    const u = user();
    const [, q] = await h.quote(await u.sign(QUOTE, { product: 'theme', pack: 'vexvoid' }));
    expect(await h.claim(await buyBody(u, 'theme', q, payTx(q, { sats: q.sats - 1 })))).toEqual([
      402,
      { error: 'underpaid' },
    ]);
    const other = new PrivateKey(9).toPublicKey().toAddress();
    expect(await h.claim(await buyBody(u, 'theme', q, payTx(q, { to: other })))).toEqual([402, { error: 'underpaid' }]);
    expect(broadcasts).toEqual([]);
  });

  test('wrong product: unknown products, unknown packs, and a quote bought as another product', async () => {
    const { h, broadcasts } = setup();
    const u = user();
    expect((await h.quote(await u.sign(QUOTE, { product: 'gold-bar' })))[1]).toEqual({ error: 'unknown_product' });
    expect((await h.quote(await u.sign(QUOTE, { product: 'theme', pack: 'gold' })))[1]).toEqual({
      error: 'pack_not_for_sale',
    });
    const [, q] = await h.quote(await u.sign(QUOTE, { product: 'theme', pack: 'npg' }));
    expect((await h.claim(await buyBody(u, 'edition', q, payTx(q))))[1]).toEqual({ error: 'quote_not_found' });
    expect((await h.claim(await buyBody(u, 'branded', q, payTx(q))))[1]).toEqual({ error: 'quote_not_found' });
    expect(broadcasts).toEqual([]);
  });

  test('edition: $99 a year through the theme-order flow', async () => {
    const { h } = setup();
    const u = user();
    const fields = {
      product: 'edition',
      slug: 'agentco',
      name: 'Agent Co',
      brand: 'Agent Co',
      isBrand: '0',
      link: 'https://agent.example',
      colours: JSON.stringify(['#ff0066', '#111111']),
      files: JSON.stringify([{ path: `${u.identityKey}/${'a'.repeat(64)}.png`, type: 'image/png', size: 1000 }]),
    };
    const [s, q] = await h.quote(await u.sign(QUOTE, fields));
    expect(s).toBe(200);
    expect(q.usd).toBe(99);
    const tx = payTx(q);
    const [s2, out] = await h.claim(await buyBody(u, 'edition', q, tx));
    expect(s2).toBe(200);
    expect(out.order.status).toBe('paid');
  });

  test('branded: pays the configured deposit with a brief; closed when no deposit is set', async () => {
    const { h } = setup();
    const u = user();
    const fields = { product: 'branded', tier: 'branded', brand: 'Agent Co', contact: 'ops@agent.example' };
    const [s, q] = await h.quote(await u.sign(QUOTE, fields));
    expect(s).toBe(200);
    expect(q.usd).toBe(250);
    expect((await h.quote(await u.sign(QUOTE, { ...fields, tier: 'native' })))[0]).toBe(400);
    const closed = setup({ THEME_ORDER_PAY_ADDRESS: PAY });
    expect((await closed.h.quote(await u.sign(QUOTE, fields)))[1]).toEqual({ error: 'not_configured' });
  });
});
