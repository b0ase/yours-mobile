// "Get your own theme" (tier 1, $99 a year): the in-wallet order flow behind bwalletx.com/themes/custom.
// Routes (site/api/theme-orders.js): upload, quote, claim, mine. Every request is signed by the identity
// key exactly like the paymail writes (BRC-43 [2,'bwallet paymail'], keyID '1', see paymail.js verifySigned).
// Env (Vercel only, never in git): THEME_ORDER_PAY_ADDRESS (empty = orders closed: 503 not_configured),
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Table + bucket: migrations/20261016_theme_orders.sql.
'use strict';
const crypto = require('crypto');
const { OP, P2PKH, Script, Utils } = require('@bsv/sdk');
const { parseIncoming, verifySigned } = require('./paymail');
const { makeStoreClaim, protocolError } = require('./storeClaim');

const PRICE_USD = 99;
const TERM_DAYS = 365;
const QUOTE_MS = 15 * 60 * 1000;
/** A payment made just before the quote ran out can still be claimed (network, app closed) for a day. */
const CLAIM_GRACE_MS = 24 * 60 * 60 * 1000;
const MEMO_TAG = 'bwx-theme-order';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 4;
const ADDRESS_RE = /^1[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
const HEX_COLOUR_RE = /^#[0-9a-f]{6}$/;
const QUOTE_ID_RE = /^[0-9a-f]{32}$/;
const ALIAS_RE = /^[a-z0-9](?:[a-z0-9_.-]{0,40}[a-z0-9])?$/;
const FILE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' };
/** Our own packs and pages under bwalletx.com/themes/ (a custom edition can't take these). */
const RESERVED_SLUGS = new Set([
  'custom',
  'new',
  'edit',
  'admin',
  'api',
  'index',
  'all',
  'mine',
  'order',
  'orders',
  'preview',
  'gold',
  'bwallet',
  'bwalletx',
  'bcorp',
  'bitcoin',
  'official',
  'default',
  'classic',
]);

const clean = (v, max) =>
  String(v ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);

/** An https URL on a public host (no IPs, no localhost, no credentials). */
function publicUrl(raw) {
  try {
    const s = String(raw || '').trim();
    if (!s || s.length > 300) return null;
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    const h = u.hostname.toLowerCase();
    if (!h.includes('.') || h === 'localhost' || h.endsWith('.local') || /^[\d.]+$/.test(h) || h.includes(':'))
      return null;
    return u.toString().slice(0, 300);
  } catch {
    return null;
  }
}

const parseJson = (s, fallback) => {
  if (typeof s !== 'string') return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

/** A file reference the wallet got back from upload: only this key's own folder. */
const validFileRef = (f, identityKey) =>
  !!f &&
  typeof f.path === 'string' &&
  new RegExp(`^${identityKey}/[0-9a-f]{64}\\.(png|jpg|svg)$`).test(f.path) &&
  FILE_TYPES[f.type] === f.path.split('.').pop() &&
  Number.isSafeInteger(f.size) &&
  f.size > 0 &&
  f.size <= MAX_FILE_BYTES;

/**
 * Validate the order form (the signed `fields`, all strings). Returns { ok: true, order } or { ok: false, error }.
 * Same rules as the wallet form (src/mobile/themeOrder/form.ts).
 */
function validateOrder(fields, identityKey) {
  const f = fields || {};
  const renew = clean(f.renew, 40).toLowerCase();
  const slug = clean(f.slug, 40).toLowerCase();
  const name = clean(f.name, 60);
  const brand = clean(f.brand, 80);
  const isBrand = f.isBrand === '1';
  const note = clean(f.note, 600);
  if (!SLUG_RE.test(slug)) return { ok: false, error: 'slug: 3–32 characters, a–z, 0–9 and - (not at the ends)' };
  if (renew && renew !== slug) return { ok: false, error: 'renew: slug mismatch' };
  if (RESERVED_SLUGS.has(slug)) return { ok: false, error: 'slug_reserved' };
  if (renew) return { ok: true, order: { slug, renew: true } };
  if (name.length < 2 || name.length > 40) return { ok: false, error: 'name: 2–40 characters' };
  if (!brand || brand.length > 60) return { ok: false, error: 'brand: enter the artist or brand name' };
  const link = publicUrl(f.link);
  if (!link) return { ok: false, error: 'link: an https:// website or social link' };
  const colours = parseJson(f.colours, null);
  if (
    !Array.isArray(colours) ||
    colours.length < 2 ||
    colours.length > 3 ||
    !colours.every((c) => typeof c === 'string' && HEX_COLOUR_RE.test(c.toLowerCase()))
  )
    return { ok: false, error: 'colours: pick 2 or 3 colours' };
  const files = parseJson(f.files, null);
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES)
    return { ok: false, error: 'files: add 1–4 logo or art files' };
  if (!files.every((x) => validFileRef(x, identityKey))) return { ok: false, error: 'files: upload again' };
  if (note.length > 500) return { ok: false, error: 'note: 500 characters max' };
  const proof = f.proof ? parseJson(f.proof, null) : null;
  if (proof && (proof.kind !== 'paymail' || !ALIAS_RE.test(String(proof.value || ''))))
    return { ok: false, error: 'proof: pick one of your verified names' };
  if (isBrand && !proof) return { ok: false, error: 'proof: brands must pick a verified identity' };
  return {
    ok: true,
    order: {
      slug,
      name,
      brand,
      is_brand: isBrand,
      links: [link],
      colours: colours.map((c) => c.toLowerCase()),
      files: files.map((x) => ({ path: x.path, type: x.type, size: x.size })),
      note: note || null,
      proof: proof ? { kind: 'paymail', value: String(proof.value) } : null,
    },
  };
}

/** OP_FALSE OP_RETURN "bwx-theme-order" <quote_id>: ties the payment to one quote. */
const memoScript = (quoteId) =>
  new Script()
    .writeOpCode(OP.OP_FALSE)
    .writeOpCode(OP.OP_RETURN)
    .writeBin(Utils.toArray(MEMO_TAG, 'utf8'))
    .writeBin(Utils.toArray(quoteId, 'utf8'));

/** Whole sats for $99 at `rate` USD per BSV, rounded up. */
const priceSats = (rate, usd = PRICE_USD) => Math.ceil(Math.round((usd / rate) * 1e8 * 1e6) / 1e6);

function payAddress(env = process.env) {
  const a = String(env.THEME_ORDER_PAY_ADDRESS || '').trim();
  return ADDRESS_RE.test(a) ? a : '';
}

/**
 * Does `tx` pay exactly this quote? The P2PKH outputs to the pay address must total exactly the quoted sats, and
 * the tx must carry exactly one OP_RETURN output, which is this quote's memo. One tx can't pay several quotes
 * (orders, purchases and deposits share the pay address). Returns null when it does, else an error code.
 */
function checkPayment(tx, { address, sats, memoHex }) {
  const script = new P2PKH().lock(address).toHex();
  const paid = tx.outputs.filter((o) => o.lockingScript.toHex() === script).reduce((s, o) => s + Number(o.satoshis), 0);
  if (paid < Number(sats)) return 'underpaid';
  if (paid !== Number(sats)) return 'amount_mismatch';
  const isReturn = (h) => h.startsWith('6a') || h.startsWith('006a');
  const memos = tx.outputs.map((o) => o.lockingScript.toHex()).filter(isReturn);
  if (!memos.includes(memoHex)) return 'memo_missing';
  if (memos.length !== 1) return 'extra_memo';
  return null;
}

/** Magic bytes match the declared type; SVGs must not carry script or event handlers. */
function sniffFile(bytes, type) {
  if (type === 'image/png') return bytes.length > 8 && bytes.subarray(0, 4).toString('hex') === '89504e47';
  if (type === 'image/jpeg') return bytes.length > 3 && bytes.subarray(0, 3).toString('hex') === 'ffd8ff';
  if (type === 'image/svg+xml') {
    const t = bytes.toString('utf8');
    return /<svg[\s>]/i.test(t) && !/<script|\son\w+\s*=|javascript:|<foreignObject/i.test(t);
  }
  return false;
}

/** Supabase (PostgREST + Storage) store for theme orders. */
function themeOrderStore(env = process.env, f = fetch) {
  const url = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const h = (extra = {}) => ({ apikey: key, Authorization: `Bearer ${key}`, ...extra });
  const q = encodeURIComponent;
  const req = async (path, init = {}) => {
    const r = await f(`${url}/rest/v1/${path}`, {
      ...init,
      headers: h({ 'Content-Type': 'application/json', ...(init.headers || {}) }),
    });
    if (!r.ok) throw new Error(`supabase ${r.status}`);
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  };
  return {
    insertOrder: async (row) =>
      (
        await req('theme_orders', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify(row),
        })
      )?.[0] ?? null,
    getByQuote: async (quoteId) => (await req(`theme_orders?quote_id=eq.${q(quoteId)}&limit=1`))?.[0] ?? null,
    getByTxid: async (txid) => (await req(`theme_orders?txid=eq.${q(txid)}&limit=1`))?.[0] ?? null,
    /** Rows that hold a slug: anything paid or later (not declined), plus live quotes. */
    slugRows: async (slug) =>
      (await req(
        `theme_orders?slug=eq.${q(slug)}&status=neq.declined&select=id,identity_key,status,quote_id,quote_expires_at,expires_at,txid,renews,slug,name,brand,quote_usd,quote_sats&limit=50`,
      )) || [],
    updateOrder: (id, patch) =>
      req(`theme_orders?id=eq.${q(id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      }),
    /** Record a txid only if the row has none yet (two claims can't both take one quote). True when this call set it. */
    setTxidIfEmpty: async (id, txid) =>
      (
        (await req(`theme_orders?id=eq.${q(id)}&txid=is.null`, {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ txid }),
        })) || []
      ).length > 0,
    /** This key's orders paid by a payment the network hasn't shown yet (status 'quoted', txid set; storeClaim.js). */
    pendingMine: async (identityKey) =>
      (await req(
        `theme_orders?identity_key=eq.${q(identityKey)}&status=eq.quoted&txid=not.is.null&select=id,identity_key,slug,name,brand,status,renews,expires_at,txid,quote_id,quote_usd,quote_sats,quote_expires_at,created_at&order=created_at.desc&limit=20`,
      )) || [],
    listMine: async (identityKey) =>
      (await req(
        `theme_orders?identity_key=eq.${q(identityKey)}&status=neq.quoted&select=id,slug,name,brand,status,expires_at,txid,created_at&order=created_at.desc&limit=50`,
      )) || [],
    aliasOwner: async (alias) =>
      (await req(`bwallet_paymail_aliases?alias=eq.${q(alias)}&select=identity_key&limit=1`))?.[0]?.identity_key ??
      null,
    uploadFile: async (path, bytes, type) => {
      const r = await f(`${url}/storage/v1/object/theme-orders/${path}`, {
        method: 'POST',
        headers: h({ 'Content-Type': type, 'x-upsert': 'true' }),
        body: bytes,
      });
      if (!r.ok) throw new Error(`storage ${r.status}`);
    },
    /** The b ops feed (bwallet_ops_events): best effort, never fails an order. */
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

/** Rows that hold a slug: paid or later, a live quote, or a quote whose payment is pending (storeClaim.js). */
const live = (row, now) =>
  ['paid', 'building', 'review', 'live'].includes(row.status) ||
  (row.status === 'quoted' && (!!row.txid || Date.parse(row.quote_expires_at) > now));

/**
 * Handlers: each returns [status, body]. Deps are injected so tests run without a network:
 * store (themeOrderStore shape), rate() → USD per BSV, broadcast(tx, beefHex) → arcSubmit result (paymailStore.js,
 * never throws), network(txid) → 'seen' | 'out' | 'missing' | 'unclear' (paymailStore.js networkStatus), env, now().
 * A claim is paid only once the network has the payment, else 202 pending (storeClaim.js, P0 3 Nov 2026); a pending
 * edition holds its slug, and becomes paid on a claim retry or the owner's next `mine`. `claimGraceMs` is no longer a
 * limit: a payment that matches its quote is honoured whenever it arrives.
 */
function makeThemeOrderHandlers({
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
  const address = () => payAddress(env);

  /** The payment is on the network: the edition is paid (or goes to review if another payer took the slug first). */
  const markPaid = async (row, txid) => {
    const t = now();
    const year = TERM_DAYS * 24 * 60 * 60 * 1000;
    const from = row.renews && row.expires_at && Date.parse(row.expires_at) > t ? Date.parse(row.expires_at) : t;
    // A paid slug can race another payer inside the quote window: the later one goes to review (refund by hand).
    const clash =
      !row.renews &&
      (await store.slugRows(row.slug)).some(
        (r) => r.identity_key !== row.identity_key && ['paid', 'building', 'review', 'live'].includes(r.status),
      );
    const patch = {
      status: clash ? 'review' : 'paid',
      txid,
      paid_at: new Date(t).toISOString(),
      expires_at: new Date(from + year).toISOString(),
    };
    await store.updateOrder(row.id, patch);
    const done = { ...row, ...patch };
    await store.notify(row.renews ? 'theme_order_renewed' : 'theme_order_paid', {
      id: row.id,
      slug: row.slug,
      name: row.name,
      brand: row.brand,
      usd: row.quote_usd,
      sats: row.quote_sats,
      txid,
      clash,
    });
    return [200, { order: publicRow(done) }];
  };
  const claimer = makeStoreClaim({
    kind: 'order',
    getByQuote: store.getByQuote,
    getByTxid: store.getByTxid,
    update: store.updateOrder,
    recheckBudgetMs,
    setTxidIfEmpty: typeof store.setTxidIfEmpty === 'function' ? store.setTxidIfEmpty : undefined,
    fetchTx,
    ledger,
    // rawtx: a raw tx hex, or the AtomicBEEF hex the wallet's createAction returns (sent with its parents).
    parse: parseIncoming,
    check: (tx, row) =>
      checkPayment(tx, { address: row.quote_address, sats: row.quote_sats, memoHex: row.quote_memo_hex }),
    broadcast,
    network,
    paid: markPaid,
    paidBody: (row) => ({ order: publicRow(row) }),
    pendingBody: (row) => ({ order: publicRow(row) }),
    now,
    log,
  });

  const upload = async (body) => {
    const sigErr = await verifySigned(body || {}, 'theme-orders-upload', now());
    if (sigErr) return [401, { error: sigErr }];
    const identityKey = String(body.identityKey).toLowerCase();
    const f = body.fields || {};
    const type = String(f.type || '');
    const ext = FILE_TYPES[type];
    if (!ext) return [400, { error: 'file: PNG, JPG or SVG only' }];
    const sha = String(f.sha256 || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha)) return [400, { error: 'file: bad hash' }];
    if (typeof body.data !== 'string' || body.data.length > Math.ceil((MAX_FILE_BYTES * 4) / 3) + 8)
      return [413, { error: 'file: 2 MB max' }];
    const bytes = Buffer.from(body.data, 'base64');
    if (!bytes.length || bytes.length > MAX_FILE_BYTES) return [413, { error: 'file: 2 MB max' }];
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== sha) return [400, { error: 'file: hash mismatch' }];
    if (!sniffFile(bytes, type)) return [400, { error: 'file: not a valid image' }];
    const path = `${identityKey}/${sha}.${ext}`;
    await store.uploadFile(path, bytes, type);
    return [200, { path, type, size: bytes.length }];
  };

  const quote = async (body) => {
    const pay = address();
    if (!pay) return [503, { error: 'not_configured' }];
    const sigErr = await verifySigned(body || {}, actions.quote || 'theme-orders-quote', now());
    if (sigErr) return [401, { error: sigErr }];
    if (requireProtocol && protocolError(body)) return protocolError(body);
    const identityKey = String(body.identityKey).toLowerCase();
    const v = validateOrder(body.fields, identityKey);
    if (!v.ok) return [400, { error: v.error }];
    const t = now();
    const holders = [];
    for (const r of await store.slugRows(v.order.slug)) {
      if (!live(r, t)) continue;
      // A pending payment holds the slug only while it may land: one nobody has (a forged or refused tx: ARC 404 or
      // REJECTED and WhatsOnChain 404) doesn't, even inside its hour (storeClaim.js recheck; review F9).
      if (r.status === 'quoted' && r.txid && ['dead', 'missing'].includes(await claimer.recheck(r))) continue;
      holders.push(r);
    }
    let renewOf = null;
    if (v.order.renew) {
      const mine = holders.filter((r) => r.identity_key === identityKey && r.status !== 'quoted');
      if (!mine.length) return [404, { error: 'renew: no edition with that slug' }];
      renewOf = mine;
    } else if (holders.some((r) => r.identity_key !== identityKey)) return [409, { error: 'slug_taken' }];
    if (v.order.proof) {
      const owner = await store.aliasOwner(v.order.proof.value);
      if (owner !== identityKey) return [403, { error: 'proof: that name is not on this wallet' }];
    }
    const r = await Promise.resolve(rate()).catch(() => 0);
    if (!(r > 0)) return [503, { error: 'price_unavailable' }];
    const sats = priceSats(r);
    const quoteId = crypto.randomBytes(16).toString('hex');
    const memoHex = memoScript(quoteId).toHex();
    const expiresAt = new Date(t + quoteMs).toISOString();
    const base = v.order.renew ? { slug: v.order.slug, renews: v.order.slug, name: null, brand: null } : { ...v.order };
    delete base.renew;
    await store.insertOrder({
      ...base,
      identity_key: identityKey,
      status: 'quoted',
      quote_id: quoteId,
      quote_usd: PRICE_USD,
      quote_sats: sats,
      quote_rate: r,
      quote_address: pay,
      quote_memo_hex: memoHex,
      quote_expires_at: expiresAt,
      ...(renewOf
        ? {
            expires_at:
              renewOf
                .map((x) => x.expires_at)
                .filter(Boolean)
                .sort()
                .pop() ?? null,
          }
        : {}),
    });
    return [
      200,
      {
        quote_id: quoteId,
        outputs: [{ script: new P2PKH().lock(pay).toHex(), satoshis: sats }],
        memo_hex: memoHex,
        usd: PRICE_USD,
        sats,
        expires_at: expiresAt,
      },
    ];
  };

  const claim = async (body) => {
    const sigErr = await verifySigned(body || {}, actions.claim || 'theme-orders-claim', now());
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

  const mine = async (body) => {
    const sigErr = await verifySigned(body || {}, 'theme-orders-mine', now());
    if (sigErr) return [401, { error: sigErr }];
    const identityKey = String(body.identityKey).toLowerCase();
    // Editions paid by a payment the network hadn't shown yet: the ones it has now become paid.
    if (typeof store.pendingMine === 'function')
      await claimer.recheckAll(((await store.pendingMine(identityKey).catch(() => [])) ?? []).slice(0, 10));
    const rows = await store.listMine(identityKey);
    return [200, { orders: rows.map(publicRow), configured: !!address() }];
  };

  return { upload, quote, claim, mine };
}

const publicRow = (r) => ({
  id: r.id,
  slug: r.slug,
  name: r.name ?? null,
  brand: r.brand ?? null,
  status: r.status,
  renews: r.renews ?? null,
  expires_at: r.expires_at ?? null,
  txid: r.txid ?? null,
  created_at: r.created_at ?? null,
});

module.exports = {
  PRICE_USD,
  TERM_DAYS,
  QUOTE_MS,
  CLAIM_GRACE_MS,
  MEMO_TAG,
  MAX_FILE_BYTES,
  RESERVED_SLUGS,
  validateOrder,
  memoScript,
  priceSats,
  payAddress,
  checkPayment,
  sniffFile,
  publicUrl,
  themeOrderStore,
  makeThemeOrderHandlers,
};
