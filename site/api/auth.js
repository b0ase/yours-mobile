// Sign in with bWalletX (lib/auth.js). Routed by site/vercel.json rewrites (served at auth.bwalletx.com):
//   /authorize, /token, /userinfo, /wallet, /.well-known/openid-configuration, /.well-known/jwks.json
//   /api/auth/<op>  (request, approve, deny, status)
'use strict';
const { makeAuth, supabaseAuthStore, bitsignLevel, walletHandoffPage } = require('../lib/auth');

let auth;
function getAuth() {
  if (auth) return auth;
  const store = supabaseAuthStore();
  const { supabaseStore } = require('../lib/paymailStore');
  const names = supabaseStore();
  const domain = require('../lib/paymail').domain();
  auth = makeAuth({
    store,
    lookupAlias: async (k) => {
      const row = names ? await names.getAliasByKey(k) : null;
      return row ? { alias: row.alias, domain } : null;
    },
    level: (alias, k) => bitsignLevel(alias, k),
  });
  return auth;
}

const hits = new Map();
function limited(ip, max) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = typeof req.body === 'string' ? req.body : '';
  if (!raw) for await (const c of req) raw += c;
  if (raw.length > 20_000) return null;
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return null;
  }
}

function out(res, r) {
  res.statusCode = r.status;
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(r.headers || {})) res.setHeader(k, v);
  if (r.redirect) {
    res.setHeader('Location', r.redirect);
    return res.end();
  }
  if (r.html != null) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(r.html);
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(r.json ?? {}));
}

const ROUTES = {
  authorize: 'GET',
  token: 'POST',
  userinfo: 'GET',
  discovery: 'GET',
  jwks: 'GET',
  wallet: 'GET',
  request: 'GET',
  approve: 'POST',
  deny: 'POST',
  status: 'GET',
};

module.exports = async function handler(req, res) {
  const q = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  const op = q.op;
  // Only answer on the issuer's own host (auth.bwalletx.com), never on bwalletx.com or a preview URL.
  const host = String(req.headers.host || '').toLowerCase();
  const allowed = new URL(process.env.BWALLETX_AUTH_ISSUER || 'https://auth.bwalletx.com').host;
  if (host !== allowed && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host))
    return out(res, { status: 404, json: { error: 'not-found' } });
  // Public, cookie-free endpoints answer any origin (SPAs call /token and /userinfo directly).
  if (op !== 'status' && op !== 'authorize') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  if (req.method === 'OPTIONS') return out(res, { status: 204 });
  if (!ROUTES[op]) return out(res, { status: 404, json: { error: 'not-found' } });
  if (req.method !== ROUTES[op] && !(op === 'userinfo' && req.method === 'POST'))
    return out(res, { status: 405, json: { error: 'method-not-allowed' } });
  const ip =
    String(req.headers['x-real-ip'] || req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim() || 'unknown';
  if (limited(ip, op === 'status' ? 120 : 60)) return out(res, { status: 429, json: { error: 'rate-limited' } });
  if (op === 'wallet') return out(res, { status: 200, html: walletHandoffPage() });
  try {
    const a = getAuth();
    if (op === 'discovery') {
      res.setHeader('Cache-Control', 'public, max-age=300');
      return out(res, await a.discovery());
    }
    if (op === 'jwks') return out(res, await a.jwks());
    if (op === 'authorize') return out(res, await a.authorize(q));
    if (op === 'userinfo') return out(res, await a.userinfo(req.headers.authorization));
    if (op === 'status') return out(res, await a.status(q, req.headers.cookie));
    if (op === 'request') return out(res, await a.request(q));
    const body = await readBody(req);
    if (body === null) return out(res, { status: 400, json: { error: 'invalid_request' } });
    return out(res, await a[op](body));
  } catch (e) {
    console.error('auth error', op, String(e && e.message ? e.message : e).slice(0, 200));
    return out(res, { status: 500, json: { error: 'server_error' } });
  }
};
