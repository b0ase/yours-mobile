// "Start your store" drafts from bwalletx.com/store. Routed by site/vercel.json:
//   POST /api/shops/upload | save | mine | check   → ?op=<op>
// upload, save and mine are signed by the wallet's identity key (site/lib/webShops.js); check is unsigned.
// Env (Vercel only): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Table: migrations/20261018_web_shops.sql.
'use strict';
const { makeWebShopHandlers, webShopStore } = require('../lib/webShops');

const OPS = new Set(['upload', 'save', 'mine', 'check']);
const ORIGINS = new Set(['https://bwalletx.com', 'https://www.bwalletx.com']);
const hits = new Map();
function limited(ip, max) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = typeof req.body === 'string' ? req.body : '';
  if (!raw) for await (const c of req) raw += c;
  if (raw.length > 3_000_000) return null;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return null;
  }
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

let handlers;
module.exports = async function handler(req, res) {
  const origin = String(req.headers.origin || '');
  // The site and its Vercel previews; every write is signed anyway, this just keeps other sites' pages out.
  if (ORIGINS.has(origin) || /^https:\/\/bwalletx-[a-z0-9-]+\.vercel\.app$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const op = new URL(req.url, 'http://x').searchParams.get('op') || '';
  if (!OPS.has(op)) return send(res, 404, { error: 'not-found' });
  if (req.method !== 'POST') return send(res, 405, { error: 'method-not-allowed' });
  const ip =
    String(req.headers['x-real-ip'] || req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim() || 'unknown';
  if (limited(ip, op === 'check' ? 60 : 20)) return send(res, 429, { error: 'rate-limited' });
  if (!handlers) {
    const store = webShopStore();
    if (!store) return send(res, 503, { error: 'not_configured' });
    handlers = makeWebShopHandlers({ store });
  }
  const body = await readJson(req);
  if (body === null) return send(res, 400, { error: 'invalid-json' });
  try {
    const [status, out] = await handlers[op](body);
    return send(res, status, out);
  } catch (e) {
    console.error('shops error', op, String(e && e.message ? e.message : e).slice(0, 200));
    return send(res, 500, { error: 'server-error' });
  }
};
