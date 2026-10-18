// "Start your store" on bwalletx.com/store: a signed-in wallet saves a DRAFT shop (name, handle, blurb, logo,
// banner, colours). Drafts are private: nothing here is shown in the in-app Store until that reads these shops
// and b has reviewed one. Routes (site/api/shops.js): upload, save, mine, check.
//
// Auth: every write is signed in the browser by the wallet's identity key over a canonical string, like the paymail
// writes, but under its OWN BRC-43 protocol [2,'bwalletx shop'] (keyID '1', counterparty 'anyone'), so a website
// never asks the wallet for a 'bwallet paymail' signature and a shop signature can't be used anywhere else.
// Env (Vercel only, never in git): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Table + bucket:
// migrations/20261018_web_shops.sql (NOT RUN until the owner approves it).
'use strict';
const crypto = require('crypto');
const { ProtoWallet, Utils } = require('@bsv/sdk');

const SIGN_PROTOCOL = [2, 'bwalletx shop'];
const SIGN_KEY_ID = '1';
const SIG_WINDOW_MS = 5 * 60 * 1000;
const PUBKEY_RE = /^0[23][0-9a-f]{64}$/;
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/;
const HEX_COLOUR_RE = /^#[0-9a-f]{6}$/;
const FILE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const MAX_BYTES = { logo: 1024 * 1024, banner: 2 * 1024 * 1024 };
const BUCKET = 'web-shops';
/** Our pages, our own shops and words that would mislead (b reviews every other name before a shop opens). */
const RESERVED_HANDLES = new Set([
  'admin',
  'api',
  'app',
  'apps',
  'b',
  'bcorp',
  'bitcoin',
  'bitcoincorp',
  'bsv',
  'bwallet',
  'bwalletx',
  'cart',
  'checkout',
  'default',
  'edit',
  'help',
  'login',
  'mine',
  'new',
  'npg',
  'npgx',
  'ninjapunkgirls',
  'official',
  'preview',
  'shop',
  'shops',
  'signin',
  'store',
  'stores',
  'support',
  'themes',
  'vexvoid',
  'www',
]);

const signedMessage = (action, fields) => {
  const keys = Object.keys(fields).sort();
  return ['bwalletx-shop', 'v1', action, ...keys.map((k) => `${k}=${fields[k] ?? ''}`)].join('|');
};

/** null when `body` is signed by body.identityKey for `action` within the time window, else an error string. */
async function verifyShopSigned(body, action, now = Date.now()) {
  const identityKey = String(body.identityKey || '').toLowerCase();
  if (!PUBKEY_RE.test(identityKey)) return 'Invalid identity key';
  const ts = Number(body.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > SIG_WINDOW_MS) return 'Signature expired; check your clock';
  if (!/^[0-9a-f]{16,200}$/i.test(String(body.signature || ''))) return 'Missing signature';
  const raw = body.fields && typeof body.fields === 'object' ? body.fields : {};
  const fields = {};
  for (const [k, v] of Object.entries(raw)) fields[k] = String(v ?? '');
  Object.assign(fields, { identityKey, timestamp: String(ts) });
  try {
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: Utils.toArray(signedMessage(action, fields), 'utf8'),
      signature: Utils.toArray(body.signature, 'hex'),
      protocolID: SIGN_PROTOCOL,
      keyID: SIGN_KEY_ID,
      counterparty: identityKey,
    });
    return valid ? null : 'Bad signature';
  } catch {
    return 'Bad signature';
  }
}

const clean = (v, max) =>
  String(v ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const parseJson = (s, fallback) => {
  if (typeof s !== 'string') return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

const normHandle = (h) => clean(h, 40).toLowerCase();
const handleError = (h) => {
  if (!HANDLE_RE.test(h)) return 'handle: 3–30 characters, a–z, 0–9 and - (not at the ends)';
  if (RESERVED_HANDLES.has(h)) return 'handle_reserved';
  return null;
};

/** A file reference from upload: only this key's own folder, the right kind and size. */
const validFileRef = (f, identityKey, kind) =>
  !!f &&
  typeof f.path === 'string' &&
  new RegExp(`^${identityKey}/${kind}-[0-9a-f]{64}\\.(png|jpg|webp)$`).test(f.path) &&
  FILE_TYPES[f.type] === f.path.split('.').pop() &&
  Number.isSafeInteger(f.size) &&
  f.size > 0 &&
  f.size <= MAX_BYTES[kind];

/** Validate the signed `fields` (all strings). Returns { ok: true, shop } or { ok: false, error }. */
function validateShop(fields, identityKey) {
  const f = fields || {};
  const handle = normHandle(f.handle);
  const hErr = handleError(handle);
  if (hErr) return { ok: false, error: hErr };
  const name = clean(f.name, 60);
  if (name.length < 2 || name.length > 40) return { ok: false, error: 'name: 2–40 characters' };
  const blurb = clean(f.blurb, 400);
  if (blurb.length > 280) return { ok: false, error: 'blurb: 280 characters max' };
  const colours = parseJson(f.colours, null);
  if (
    !colours ||
    typeof colours !== 'object' ||
    !['accent', 'background'].every(
      (k) => typeof colours[k] === 'string' && HEX_COLOUR_RE.test(colours[k].toLowerCase()),
    )
  )
    return { ok: false, error: 'colours: pick an accent and a background colour' };
  const out = {
    handle,
    name,
    blurb: blurb || null,
    colours: { accent: colours.accent.toLowerCase(), background: colours.background.toLowerCase() },
  };
  for (const kind of ['logo', 'banner']) {
    const ref = f[kind] ? parseJson(f[kind], null) : null;
    if (ref && !validFileRef(ref, identityKey, kind)) return { ok: false, error: `${kind}: upload it again` };
    out[kind] = ref ? { path: ref.path, type: ref.type, size: ref.size } : null;
  }
  return { ok: true, shop: out };
}

/** Magic bytes match the declared type (no SVG: shop art is shown to other people later). */
function sniffFile(bytes, type) {
  if (type === 'image/png') return bytes.length > 8 && bytes.subarray(0, 4).toString('hex') === '89504e47';
  if (type === 'image/jpeg') return bytes.length > 3 && bytes.subarray(0, 3).toString('hex') === 'ffd8ff';
  if (type === 'image/webp')
    return (
      bytes.length > 12 &&
      bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
      bytes.subarray(8, 12).toString('latin1') === 'WEBP'
    );
  return false;
}

/** Supabase (PostgREST + Storage) store for web shops. */
function webShopStore(env = process.env, f = fetch) {
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
  const COLS = 'id,identity_key,handle,name,blurb,logo,banner,colours,status,created_at,updated_at';
  return {
    getByKey: async (k) => (await req(`web_shops?identity_key=eq.${q(k)}&select=${COLS}&limit=1`))?.[0] ?? null,
    getByHandle: async (hd) =>
      (await req(`web_shops?handle=eq.${q(hd)}&select=identity_key,status&limit=1`))?.[0] ?? null,
    insert: async (row) =>
      (
        await req('web_shops', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify(row),
        })
      )?.[0] ?? null,
    update: async (id, patch) =>
      (
        await req(`web_shops?id=eq.${q(id)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify(patch),
        })
      )?.[0] ?? null,
    uploadFile: async (path, bytes, type) => {
      const r = await f(`${url}/storage/v1/object/${BUCKET}/${path}`, {
        method: 'POST',
        headers: h({ 'Content-Type': type, 'x-upsert': 'true' }),
        body: bytes,
      });
      if (!r.ok) throw new Error(`storage ${r.status}`);
    },
    /** A one-hour link so the owner's own preview can show their private draft art after a reload. */
    signedUrl: async (path) => {
      const r = await f(`${url}/storage/v1/object/sign/${BUCKET}/${path}`, {
        method: 'POST',
        headers: h({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ expiresIn: 3600 }),
      });
      if (!r.ok) return null;
      const j = await r.json().catch(() => ({}));
      return j.signedURL ? `${url}/storage/v1${j.signedURL}` : null;
    },
    /** The b ops feed (bwallet_ops_events): best effort, never fails a save. */
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

const isUniqueViolation = (e) => /supabase 409/.test(String(e && e.message));

/** Handlers: each returns [status, body]. Deps injected so tests run without a network. */
function makeWebShopHandlers({ store, now = () => Date.now() }) {
  const publicShop = async (row) => {
    const art = async (ref) => (ref ? { ...ref, url: await store.signedUrl(ref.path).catch(() => null) } : null);
    return {
      handle: row.handle,
      name: row.name,
      blurb: row.blurb ?? null,
      colours: row.colours,
      logo: await art(row.logo),
      banner: await art(row.banner),
      status: row.status,
      url: `https://bwalletx.com/shop/${row.handle}`,
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null,
    };
  };

  const upload = async (body) => {
    const sigErr = await verifyShopSigned(body || {}, 'shop-upload', now());
    if (sigErr) return [401, { error: sigErr }];
    const identityKey = String(body.identityKey).toLowerCase();
    const f = body.fields || {};
    const kind = String(f.kind || '');
    if (!MAX_BYTES[kind]) return [400, { error: 'kind: logo or banner' }];
    const type = String(f.type || '');
    const ext = FILE_TYPES[type];
    if (!ext) return [400, { error: 'file: PNG, JPG or WebP only' }];
    const sha = String(f.sha256 || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha)) return [400, { error: 'file: bad hash' }];
    if (typeof body.data !== 'string' || body.data.length > Math.ceil((MAX_BYTES[kind] * 4) / 3) + 8)
      return [413, { error: `file: ${MAX_BYTES[kind] / 1024 / 1024} MB max` }];
    const bytes = Buffer.from(body.data, 'base64');
    if (!bytes.length || bytes.length > MAX_BYTES[kind])
      return [413, { error: `file: ${MAX_BYTES[kind] / 1024 / 1024} MB max` }];
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== sha) return [400, { error: 'file: hash mismatch' }];
    if (!sniffFile(bytes, type)) return [400, { error: 'file: not a valid image' }];
    const path = `${identityKey}/${kind}-${sha}.${ext}`;
    await store.uploadFile(path, bytes, type);
    return [200, { path, type, size: bytes.length }];
  };

  const save = async (body) => {
    const sigErr = await verifyShopSigned(body || {}, 'shop-save', now());
    if (sigErr) return [401, { error: sigErr }];
    const identityKey = String(body.identityKey).toLowerCase();
    const v = validateShop(body.fields, identityKey);
    if (!v.ok) return [400, { error: v.error }];
    const holder = await store.getByHandle(v.shop.handle);
    if (holder && holder.identity_key !== identityKey) return [409, { error: 'handle_taken' }];
    const mine = await store.getByKey(identityKey);
    // Once b is reviewing it or it is open, the handle is fixed (a rename goes through b).
    if (mine && mine.status !== 'draft' && mine.handle !== v.shop.handle) return [409, { error: 'handle_locked' }];
    const t = new Date(now()).toISOString();
    let row;
    try {
      row = mine
        ? await store.update(mine.id, { ...v.shop, updated_at: t })
        : await store.insert({ ...v.shop, identity_key: identityKey, status: 'draft', created_at: t, updated_at: t });
    } catch (e) {
      if (isUniqueViolation(e)) return [409, { error: 'handle_taken' }];
      throw e;
    }
    if (!mine) await store.notify('web_shop_draft', { handle: v.shop.handle, name: v.shop.name, identityKey });
    return [200, { shop: await publicShop(row) }];
  };

  const mine = async (body) => {
    const sigErr = await verifyShopSigned(body || {}, 'shop-mine', now());
    if (sigErr) return [401, { error: sigErr }];
    const row = await store.getByKey(String(body.identityKey).toLowerCase());
    return [200, { shop: row ? await publicShop(row) : null }];
  };

  /** Unsigned: is this handle free? (Says only free / taken / reserved / invalid.) */
  const check = async (body) => {
    const handle = normHandle(body && body.handle);
    const err = handleError(handle);
    if (err) return [200, { handle, available: false, reason: err === 'handle_reserved' ? 'reserved' : 'invalid' }];
    const holder = await store.getByHandle(handle);
    const key = String((body && body.identityKey) || '').toLowerCase();
    const free = !holder || (PUBKEY_RE.test(key) && holder.identity_key === key);
    return [200, { handle, available: free, reason: free ? null : 'taken' }];
  };

  return { upload, save, mine, check };
}

module.exports = {
  SIGN_PROTOCOL,
  SIGN_KEY_ID,
  MAX_BYTES,
  RESERVED_HANDLES,
  signedMessage,
  verifyShopSigned,
  validateShop,
  sniffFile,
  webShopStore,
  makeWebShopHandlers,
};
