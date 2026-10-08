// bWallet paymail (bsvalias) endpoint. Routed by site/vercel.json rewrites:
//   /.well-known/bsvalias                     → ?op=caps
//   /api/paymail/<op>/<handle>[/<pubkey>]     → ?op=<op>&handle=…&pubkey=…
//   /api/paymail/<op>                         → ?op=<op>   (register, lookup, inbox, ack, delete)
// Env: PAYMAIL_DOMAIN (primary, default bwallet-nine.vercel.app), PAYMAIL_DOMAINS (optional,
//      comma-separated extra domains served with the same aliases), PAYMAIL_BASE_URL (optional),
//      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ARC_URL / ARC_API_KEY (optional).
'use strict';
const { makeHandlers } = require('../lib/paymail');
const { supabaseStore, arcBroadcast } = require('../lib/paymailStore');

const ROUTES = {
  caps: ['GET', 'caps'],
  id: ['GET', 'pki'],
  profile: ['GET', 'profile'],
  verify: ['GET', 'verify'],
  ord: ['GET', 'ord'],
  'p2p-destination': ['POST', 'p2pDestination'],
  'receive-tx': ['POST', 'receive'],
  'receive-beef': ['POST', 'receive'],
  register: ['POST', 'register'],
  lookup: ['GET', 'lookup'],
  social: ['GET', 'social'],
  inbox: ['POST', 'inbox'],
  ack: ['POST', 'ack'],
  delete: ['POST', 'delete'],
  unlink: ['POST', 'unlink'],
  'apps-get': ['POST', 'appsGet'],
  'apps-put': ['POST', 'appsPut'],
  // bPhone (docs/BPHONE-PLAN.md): public rate card + directory, signed writes and bookings.
  'bphone-get': ['GET', 'bphone-get'],
  'bphone-put': ['POST', 'bphone-put'],
  'bphone-directory': ['GET', 'bphone-directory'],
  'bphone-book': ['POST', 'bphone-book'],
  'bphone-bookings': ['POST', 'bphone-bookings'],
  'bphone-book-act': ['POST', 'bphone-book-act'],
};

const hits = new Map();
function limited(ip, max = 120) {
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
  if (raw.length > 4_000_000) return null;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return null;
  }
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

let handlers;
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, 'http://x');
  const q = Object.fromEntries(url.searchParams);
  const route = ROUTES[q.op || 'caps'];
  if (!route) return send(res, 404, { error: 'not-found' });
  if (req.method !== route[0]) return send(res, 405, { error: 'method-not-allowed' });
  res.setHeader(
    'Cache-Control',
    route[1] === 'caps'
      ? 'public, max-age=300'
      : route[1] === 'bphone-get' || route[1] === 'bphone-directory'
        ? 'public, max-age=30'
        : 'no-store',
  );
  const ip =
    String(req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim() || 'unknown';
  if (limited(ip)) return send(res, 429, { error: 'rate-limited' });

  if (!handlers) {
    const store = supabaseStore();
    if (!store && route[1] !== 'caps') return send(res, 503, { error: 'paymail-not-configured' });
    handlers = store ? makeHandlers({ store, broadcast: arcBroadcast() }) : null;
  }
  if (!handlers) return send(res, 200, require('../lib/paymail').capabilities());

  const body = req.method === 'POST' ? await readJson(req) : {};
  if (body === null) return send(res, 400, { error: 'invalid-json' });
  try {
    const [status, out] = await handlers[route[1]](q, body);
    return send(res, status, out);
  } catch (e) {
    console.error('paymail error', route[1], String(e && e.message ? e.message : e).slice(0, 200));
    return send(res, 500, { error: 'server-error' });
  }
};
