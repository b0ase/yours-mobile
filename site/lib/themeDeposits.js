// Branded wallet deposits (bwalletx.com/themes/custom/orderform): a brand sends its brief and pays a deposit
// for a Branded edition (from $999) or a Native app (by quote). Same quote → one approval → claim flow and the
// same pay address as theme orders (themeOrders.js): the site signs with the visitor's BRC-100 wallet (Sign in
// with bWalletX), the claim checks the outputs + memo, then broadcasts. Nothing is recorded as paid unless the
// network has the tx: until then the claim answers 202 pending (storeClaim.js, P0 3 Nov 2026).
// Env (Vercel only, never in git): THEME_ORDER_PAY_ADDRESS (shared with theme orders) and THEME_DEPOSIT_USD
// (the deposit in whole US dollars; empty = deposits closed: 503 not_configured). Table: migrations/20261018_theme_deposits.sql.
'use strict';
const crypto = require('crypto');
const { OP, Script, Utils, P2PKH } = require('@bsv/sdk');
const { parseIncoming, verifySigned } = require('./paymail');
const { checkPayment, payAddress, priceSats, publicUrl } = require('./themeOrders');
const { makeStoreClaim } = require('./storeClaim');

const MEMO_TAG = 'bwx-theme-deposit';
const QUOTE_MS = 15 * 60 * 1000;
const CLAIM_GRACE_MS = 24 * 60 * 60 * 1000;
const TIERS = new Set(['branded', 'native']);
const HEX_COLOUR_RE = /^#[0-9a-f]{6}$/;
const QUOTE_ID_RE = /^[0-9a-f]{32}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;
const HANDLE_RE = /^[@$]?[a-z0-9_.-]{2,40}(@[a-z0-9.-]+\.[a-z]{2,24})?$/i;
const MAX_DEPOSIT_USD = 10000;

const clean = (v, max) =>
  String(v ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);

/** The deposit in USD from THEME_DEPOSIT_USD, or 0 when deposits are closed. */
function depositUsd(env = process.env) {
  const n = Number(String(env.THEME_DEPOSIT_USD || '').trim());
  return Number.isInteger(n) && n > 0 && n <= MAX_DEPOSIT_USD ? n : 0;
}

/** The brief (signed `fields`, all strings). Returns { ok: true, brief } or { ok: false, error }. */
function validateBrief(fields) {
  const f = fields || {};
  const tier = clean(f.tier, 20).toLowerCase();
  if (!TIERS.has(tier)) return { ok: false, error: 'tier: branded or native' };
  const brand = clean(f.brand, 80);
  if (brand.length < 2 || brand.length > 60) return { ok: false, error: 'brand: 2–60 characters' };
  const contact = clean(f.contact, 200);
  if (!EMAIL_RE.test(contact) && !HANDLE_RE.test(contact))
    return { ok: false, error: 'contact: an email address or a handle' };
  const link = f.link ? publicUrl(f.link) : null;
  if (f.link && !link) return { ok: false, error: 'link: an https:// website or social link' };
  const logo = f.logo ? publicUrl(f.logo) : null;
  if (f.logo && !logo) return { ok: false, error: 'logo: an https:// link to your logo' };
  let colours = [];
  if (f.colours) {
    try {
      colours = JSON.parse(f.colours);
    } catch {
      colours = null;
    }
    if (
      !Array.isArray(colours) ||
      colours.length > 3 ||
      !colours.every((c) => typeof c === 'string' && HEX_COLOUR_RE.test(c.toLowerCase()))
    )
      return { ok: false, error: 'colours: up to 3 colours' };
  }
  const note = clean(f.note, 1200);
  if (note.length > 1000) return { ok: false, error: 'note: 1000 characters max' };
  return {
    ok: true,
    brief: {
      tier,
      brand,
      contact,
      links: [link, logo].filter(Boolean),
      logo,
      colours: colours.map((c) => c.toLowerCase()),
      note: note || null,
    },
  };
}

/** OP_FALSE OP_RETURN "bwx-theme-deposit" <quote_id>. */
const memoScript = (quoteId) =>
  new Script()
    .writeOpCode(OP.OP_FALSE)
    .writeOpCode(OP.OP_RETURN)
    .writeBin(Utils.toArray(MEMO_TAG, 'utf8'))
    .writeBin(Utils.toArray(quoteId, 'utf8'));

/** Supabase store for deposits (PostgREST). */
function themeDepositStore(env = process.env, f = fetch) {
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
    insertDeposit: async (row) =>
      (
        await req('theme_deposits', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify(row),
        })
      )?.[0] ?? null,
    getByQuote: async (quoteId) => (await req(`theme_deposits?quote_id=eq.${q(quoteId)}&limit=1`))?.[0] ?? null,
    getByTxid: async (txid) => (await req(`theme_deposits?txid=eq.${q(txid)}&limit=1`))?.[0] ?? null,
    updateDeposit: (id, patch) =>
      req(`theme_deposits?id=eq.${q(id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      }),
    /** Record a txid only if the row has none yet (two claims can't both take one quote). True when this call set it. */
    setTxidIfEmpty: async (id, txid) =>
      (
        (await req(`theme_deposits?id=eq.${q(id)}&txid=is.null`, {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ txid }),
        })) || []
      ).length > 0,
    /** This key's deposits paid by a payment the network hasn't shown yet (status 'quoted', txid set; storeClaim.js). */
    pendingMine: async (identityKey) =>
      (await req(
        `theme_deposits?identity_key=eq.${q(identityKey)}&status=eq.quoted&txid=not.is.null&select=*&order=created_at.desc&limit=20`,
      )) || [],
    listMine: async (identityKey) =>
      (await req(
        `theme_deposits?identity_key=eq.${q(identityKey)}&status=neq.quoted&select=*&order=created_at.desc&limit=50`,
      )) || [],
    notify: async (kind, payload) => {
      console.log(`[ops] ${kind}`, JSON.stringify(payload).slice(0, 500));
      try {
        await req('bwallet_ops_events', {
          method: 'POST',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ kind, payload }),
        });
      } catch {
        /* logged above */
      }
    },
  };
}

const publicRow = (r) => ({
  id: r.id,
  tier: r.tier,
  brand: r.brand,
  status: r.status,
  usd: r.quote_usd,
  txid: r.txid ?? null,
  paid_at: r.paid_at ?? null,
});

/**
 * Handlers return [status, body]. Deps injected for tests: store, rate() USD per BSV, broadcast(tx, beefHex) → arcSubmit
 * result, network(txid) → networkStatus verdict (paymailStore.js), env, now(). Paid only once the network has the
 * payment, else 202 pending (storeClaim.js); `claimGraceMs` is no longer a limit (a matching payment is honoured).
 */
function makeThemeDepositHandlers({
  store,
  ledger,
  rate,
  broadcast,
  network = async () => 'unclear',
  fetchTx,
  recheckBudgetMs,
  env = process.env,
  now = () => Date.now(),
  quoteMs = QUOTE_MS,
  claimGraceMs: _claimGraceMs = CLAIM_GRACE_MS, // no longer a limit (storeClaim.js); kept so callers can pass it
  actions = {},
  log,
}) {
  if (!ledger || typeof ledger.reserve !== 'function') throw new Error('paid-txid ledger required');
  const markPaid = async (row, txid) => {
    const patch = { status: 'paid', txid, paid_at: new Date(now()).toISOString() };
    await store.updateDeposit(row.id, patch);
    await store.notify('theme_deposit_paid', {
      id: row.id,
      tier: row.tier,
      brand: row.brand,
      contact: row.contact,
      usd: row.quote_usd,
      sats: row.quote_sats,
      txid,
    });
    return [200, { deposit: publicRow({ ...row, ...patch }) }];
  };
  const claimer = makeStoreClaim({
    kind: 'deposit',
    getByQuote: store.getByQuote,
    getByTxid: store.getByTxid,
    update: store.updateDeposit,
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
    paidBody: (row) => ({ deposit: publicRow(row) }),
    pendingBody: (row) => ({ deposit: publicRow(row) }),
    now,
    log,
  });
  const config = async () => {
    const usd = depositUsd(env);
    return [200, { configured: !!(usd && payAddress(env)), usd: usd || null }];
  };

  const quote = async (body) => {
    const pay = payAddress(env);
    const usd = depositUsd(env);
    if (!pay || !usd) return [503, { error: 'not_configured' }];
    const sigErr = await verifySigned(body || {}, actions.quote || 'theme-deposit-quote', now());
    if (sigErr) return [401, { error: sigErr }];
    const identityKey = String(body.identityKey).toLowerCase();
    const v = validateBrief(body.fields);
    if (!v.ok) return [400, { error: v.error }];
    const r = await Promise.resolve(rate()).catch(() => 0);
    if (!(r > 0)) return [503, { error: 'price_unavailable' }];
    const sats = priceSats(r, usd);
    const quoteId = crypto.randomBytes(16).toString('hex');
    const memoHex = memoScript(quoteId).toHex();
    const expiresAt = new Date(now() + quoteMs).toISOString();
    await store.insertDeposit({
      ...v.brief,
      identity_key: identityKey,
      status: 'quoted',
      quote_id: quoteId,
      quote_usd: usd,
      quote_sats: sats,
      quote_rate: r,
      quote_address: pay,
      quote_memo_hex: memoHex,
      quote_expires_at: expiresAt,
    });
    return [
      200,
      {
        quote_id: quoteId,
        outputs: [{ script: new P2PKH().lock(pay).toHex(), satoshis: sats }],
        memo_hex: memoHex,
        usd,
        sats,
        expires_at: expiresAt,
      },
    ];
  };

  const claim = async (body) => {
    const sigErr = await verifySigned(body || {}, actions.claim || 'theme-deposit-claim', now());
    if (sigErr) return [401, { error: sigErr }];
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

  /**
   * The payer's deposits, after re-checking the pending ones (review 4 Nov 2026, F6): a deposit answered 202 becomes
   * paid here once the network has it (and its "deposit paid" notice goes out). Deposits are off until the site form
   * handles 202; this is the path it will poll.
   */
  const status = async (body) => {
    const sigErr = await verifySigned(body || {}, actions.status || 'theme-deposit-status', now());
    if (sigErr) return [401, { error: sigErr }];
    const identityKey = String(body.identityKey).toLowerCase();
    const pending = typeof store.pendingMine === 'function' ? await store.pendingMine(identityKey).catch(() => []) : [];
    await claimer.recheckAll((pending || []).slice(0, 10));
    const rows = typeof store.listMine === 'function' ? await store.listMine(identityKey).catch(() => []) : [];
    const still = typeof store.pendingMine === 'function' ? await store.pendingMine(identityKey).catch(() => []) : [];
    return [
      200,
      {
        deposits: (rows || []).map(publicRow),
        pending: (still || []).map((r) => ({ ...publicRow(r), pending: true })),
      },
    ];
  };

  return { config, quote, claim, status };
}

module.exports = { MEMO_TAG, depositUsd, validateBrief, memoScript, themeDepositStore, makeThemeDepositHandlers };
