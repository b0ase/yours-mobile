// Store theme purchases ($1 each, owner 17 Oct 2026): VexVoid, NPG and NPGX in Store › Themes.
// Routes (site/api/theme-orders.js): buy-quote, buy-claim, owned. Signed by the identity key like the theme
// orders (themeOrders.js), paid to THEME_ORDER_PAY_ADDRESS with an OP_RETURN memo that ties the payment to
// one quote. Table: migrations/20261017_theme_purchases.sql. Env (Vercel only): as themeOrders.js.
'use strict';
const crypto = require('crypto');
const { OP, P2PKH, Script, Utils } = require('@bsv/sdk');
const { parseIncoming, verifySigned } = require('./paymail');
const { checkPayment, payAddress, priceSats, QUOTE_MS, CLAIM_GRACE_MS } = require('./themeOrders');
const { signReceipt } = require('./storeReceipt');
const { makeStoreClaim, protocolError } = require('./storeClaim');

const FEE_ROOM_SATS = 500;

/** Emoji themes (owner 18 Oct 2026, src/mobile/theme/emojiThemes.ts): $1 each, Twemoji art. */
const EMOJI_LABELS = {
  'emoji-frog': 'Frog',
  'emoji-fire': 'Fire',
  'emoji-wave': 'Wave',
  'emoji-blossom': 'Blossom',
  'emoji-spark': 'Spark',
  'emoji-moon': 'Moon',
  'emoji-pizza': 'Pizza',
  'emoji-headphones': 'Headphones',
  'emoji-pup': 'Pup',
  'emoji-rainbow': 'Rainbow',
  'emoji-clover': 'Clover',
  'emoji-cool': 'Cool',
};
/** Packs for sale and their price in USD. Only these can be bought. */
const PACKS = {
  vexvoid: 1,
  npg: 1,
  npgx: 1,
  scammerscartel: 1,
  tokenblaster: 1,
  terrornode: 1,
  ...Object.fromEntries(Object.keys(EMOJI_LABELS).map((id) => [id, 1])),
};
/** Names printed on receipts. */
const PACK_LABELS = {
  vexvoid: 'VexVoid',
  npg: 'NPG',
  npgx: 'NPGX',
  scammerscartel: 'Scammers Cartel',
  tokenblaster: 'TokenBlaster',
  terrornode: 'Assault on Terrornode (TokenBlaster)',
  ...Object.fromEntries(Object.entries(EMOJI_LABELS).map(([id, l]) => [id, `${l} (Emoji)`])),
};
const MEMO_TAG = 'bwx-theme-buy';
const QUOTE_ID_RE = /^[0-9a-f]{32}$/;

/** OP_FALSE OP_RETURN "bwx-theme-buy" <quote_id>. */
const memoScript = (quoteId) =>
  new Script()
    .writeOpCode(OP.OP_FALSE)
    .writeOpCode(OP.OP_RETURN)
    .writeBin(Utils.toArray(MEMO_TAG, 'utf8'))
    .writeBin(Utils.toArray(quoteId, 'utf8'));

/** Supabase (PostgREST) store for theme purchases. */
function themeBuyStore(env = process.env, f = fetch) {
  const url = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const q = encodeURIComponent;
  const req = async (path, init = {}) => {
    const r = await f(`${url}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    if (!r.ok) throw new Error(`supabase ${r.status}`);
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  };
  return {
    insert: async (row) =>
      (
        await req('theme_purchases', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify(row),
        })
      )?.[0] ?? null,
    getByQuote: async (quoteId) => (await req(`theme_purchases?quote_id=eq.${q(quoteId)}&limit=1`))?.[0] ?? null,
    getByTxid: async (txid) => (await req(`theme_purchases?txid=eq.${q(txid)}&limit=1`))?.[0] ?? null,
    update: (id, patch) =>
      req(`theme_purchases?id=eq.${q(id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      }),
    /** Record a txid only if the row has none yet (two claims can't both take one quote). True when this call set it. */
    setTxidIfEmpty: async (id, txid) =>
      (
        (await req(`theme_purchases?id=eq.${q(id)}&txid=is.null`, {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ txid }),
        })) || []
      ).length > 0,
    owned: async (identityKey) =>
      (await req(
        `theme_purchases?identity_key=eq.${q(identityKey)}&status=eq.paid&select=pack_id,txid,paid_at&limit=200`,
      )) || [],
    /**
     * Paid by a payment the network hasn't shown yet: status still 'quoted', txid set (storeClaim.js). Newest first.
     * With packId, only that pack's (review 16 F7: the 20-row cap could hide the one that matters).
     */
    pending: async (identityKey, packId) =>
      (await req(
        `theme_purchases?identity_key=eq.${q(identityKey)}${packId ? `&pack_id=eq.${q(packId)}` : ''}&status=eq.quoted&txid=not.is.null&select=id,identity_key,pack_id,status,txid,quote_id,quote_expires_at&order=created_at.desc&limit=20`,
      )) || [],
  };
}

/**
 * Handlers: each returns [status, body]. Deps injected so tests run without a network:
 * store (themeBuyStore shape), rate() → USD per BSV, broadcast(tx, beefHex) → arcSubmit result (paymailStore.js,
 * never throws), network(txid) → 'seen' | 'out' | 'missing' | 'unclear' (paymailStore.js networkStatus), env, now().
 *
 * Paid means the network has the payment (storeClaim.js, P0 3 Nov 2026): a claim the network hasn't shown yet is
 * answered 202 { pending: true } and becomes paid on a claim retry or the buyer's next `owned`; while it is pending
 * the pack can't be quoted again (409 payment_pending) unless the payment never reached the network.
 * `claimGraceMs` is no longer a limit: a payment that matches its quote is honoured whenever it arrives.
 */
function makeThemeBuyHandlers({
  store,
  ledger,
  rate,
  broadcast,
  network = async () => 'unclear',
  fetchTx,
  recheckBudgetMs,
  requireProtocol = false,
  env = process.env,
  now = () => Date.now(),
  quoteMs = QUOTE_MS,
  claimGraceMs: _claimGraceMs = CLAIM_GRACE_MS, // no longer a limit (storeClaim.js); kept so callers can pass it
  actions = {},
  log,
}) {
  if (!ledger || typeof ledger.reserve !== 'function') throw new Error('paid-txid ledger required');
  const markPaid = async (row, txid) => {
    await store.update(row.id, { status: 'paid', txid, paid_at: new Date(now()).toISOString() });
    return [200, { pack: row.pack_id, txid }];
  };
  const claimer = makeStoreClaim({
    kind: 'buy',
    getByQuote: store.getByQuote,
    getByTxid: store.getByTxid,
    update: store.update,
    recheckBudgetMs,
    setTxidIfEmpty: typeof store.setTxidIfEmpty === 'function' ? store.setTxidIfEmpty : undefined,
    fetchTx,
    ledger,
    parse: parseIncoming,
    check: (tx, row) =>
      checkPayment(tx, { address: row.quote_address, sats: row.quote_sats, memoHex: row.quote_memo_hex }),
    broadcast,
    network,
    paid: markPaid,
    paidBody: (row) => ({ pack: row.pack_id, txid: row.txid }),
    pendingBody: (row) => ({ pack: row.pack_id }),
    // b-Aware shdx (29 Oct 2026): a quote taken before the pack was bought must not be payable once it is owned or
    // another payment for it is on its way (storeClaim.js rule 9). Same answers as a second quote gets below.
    conflict: (row, txid) => packConflict(row.identity_key, row.pack_id, { except: row.id, txid }),
    now,
    log,
  });
  const pendingOf = async (identityKey) =>
    typeof store.pending === 'function' ? ((await store.pending(identityKey).catch(() => [])) ?? []) : [];
  /**
   * Why this buyer may not pay for this pack now: owned (409 already_owned), or a payment for it on its way that the
   * network may still take (409 payment_pending). `except` is the row being claimed, `txid` its own payment.
   */
  async function packConflict(identityKey, packId, { except, txid } = {}) {
    if ((await store.owned(identityKey)).some((r) => r.pack_id === packId && (!txid || r.txid !== txid)))
      return [409, { error: 'already_owned' }];
    // Read strictly: a database error is not "nothing pending" (review 16 F7, fail closed).
    let pending;
    try {
      pending = typeof store.pending === 'function' ? ((await store.pending(identityKey, packId)) ?? []) : [];
    } catch {
      return [503, { error: 'store_unavailable' }];
    }
    for (const p of pending.filter((r) => r.pack_id === packId && r.id !== except)) {
      const r = await claimer.recheck(p);
      if (r === 'paid') return [409, { error: 'already_owned' }];
      if (r === 'pending' || r === 'missing') return [409, { error: 'payment_pending' }];
    }
    return null;
  }

  const quote = async (body) => {
    const pay = payAddress(env);
    if (!pay) return [503, { error: 'not_configured' }];
    const sigErr = await verifySigned(body || {}, actions.quote || 'theme-buy-quote', now());
    if (sigErr) return [401, { error: sigErr }];
    if (requireProtocol && protocolError(body)) return protocolError(body);
    const identityKey = String(body.identityKey).toLowerCase();
    const packId = String((body.fields || {}).pack || '');
    if (!Object.prototype.hasOwnProperty.call(PACKS, packId)) return [404, { error: 'pack_not_for_sale' }];
    // Owned, or a payment for this pack is out and the network hasn't shown it yet: don't take a second one.
    const busy = await packConflict(identityKey, packId);
    if (busy) return busy;
    const r = await Promise.resolve(rate()).catch(() => 0);
    if (!(r > 0)) return [503, { error: 'price_unavailable' }];
    const usd = PACKS[packId];
    // "$1" is the most it costs: leave room for the network fee inside the price, so a wallet holding exactly
    // $1 can buy (owner, 17 Oct 2026: $1 in the wallet, refused 25 sats short). ~500 sats is a hundredth of a cent.
    const sats = Math.max(1, priceSats(r, usd) - FEE_ROOM_SATS);
    const quoteId = crypto.randomBytes(16).toString('hex');
    const memoHex = memoScript(quoteId).toHex();
    const expiresAt = new Date(now() + quoteMs).toISOString();
    await store.insert({
      identity_key: identityKey,
      pack_id: packId,
      status: 'quoted',
      quote_id: quoteId,
      quote_usd: usd,
      quote_sats: sats,
      quote_rate: r,
      quote_address: pay,
      quote_memo_hex: memoHex,
      quote_expires_at: expiresAt,
    });
    // The receipt the buyer's wallet inscribes in the paying transaction (storeReceipt.js).
    const receipt = signReceipt(
      {
        app: 'bwalletx',
        type: 'store-receipt',
        v: 1,
        order: quoteId,
        item: { kind: 'theme', id: packId, label: PACK_LABELS[packId] || packId },
        usd,
        sats,
        seller: pay,
        buyer: identityKey,
        issuedAt: new Date(now()).toISOString(),
      },
      env,
    );
    return [
      200,
      {
        quote_id: quoteId,
        pack: packId,
        receipt,
        outputs: [{ script: new P2PKH().lock(pay).toHex(), satoshis: sats }],
        memo_hex: memoHex,
        usd,
        sats,
        expires_at: expiresAt,
      },
    ];
  };

  const claim = async (body) => {
    const sigErr = await verifySigned(body || {}, actions.claim || 'theme-buy-claim', now());
    if (sigErr) return [401, { error: sigErr }];
    if (requireProtocol && protocolError(body)) return protocolError(body);
    const f = body.fields || {};
    const quoteId = String(f.quote_id || '');
    if (!QUOTE_ID_RE.test(quoteId)) return [400, { error: 'quote_id' }];
    return claimer.claim({
      identityKey: String(body.identityKey).toLowerCase(),
      quoteId,
      txid: String(f.txid || '').toLowerCase(),
      rawtx: body.rawtx,
      intent: f.intent === '1',
    });
  };

  const owned = async (body) => {
    const sigErr = await verifySigned(body || {}, 'theme-buy-owned', now());
    if (sigErr) return [401, { error: sigErr }];
    const identityKey = String(body.identityKey).toLowerCase();
    // Pending purchases (claimed, not yet seen by the network): newest first, the ones the network has now become paid.
    await claimer.recheckAll((await pendingOf(identityKey)).slice(0, 10));
    const rows = await store.owned(identityKey);
    return [200, { packs: [...new Set(rows.map((r) => r.pack_id))], configured: !!payAddress(env) }];
  };

  return { quote, claim, owned };
}

module.exports = { PACKS, PACK_LABELS, MEMO_TAG, memoScript, themeBuyStore, makeThemeBuyHandlers };
