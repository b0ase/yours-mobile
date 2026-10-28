// Agent purchase API (site/lib/agentBuy.js). Routed by site/vercel.json:
//   GET  /api/agent/products       → ?op=products   the catalogue + live prices
//   POST /api/agent/quote          → ?op=quote      signed; 5-minute single-use quote (USD, sats, MNEE)
//   POST /api/agent/buy            → ?op=buy        signed; checks the paying tx, broadcasts, grants
// Env (Vercel only): as site/api/theme-orders.js (THEME_ORDER_PAY_ADDRESS, THEME_DEPOSIT_USD, SUPABASE_*, ARC_*).
'use strict';
const { makeThemeOrderHandlers, themeOrderStore } = require('../lib/themeOrders');
const { makeThemeBuyHandlers, themeBuyStore } = require('../lib/themeBuys');
const { makeThemeDepositHandlers, themeDepositStore } = require('../lib/themeDeposits');
const { agentHandlerOptions, listProducts, makeAgentBuyHandlers } = require('../lib/agentBuy');
const { arcBroadcast } = require('../lib/paymailStore');
const { chain } = require('../lib/nameFee');
const { paidTxidStore } = require('../lib/paidTxids');

const LIMITS = { quote: 10, buy: 20 }; // per minute, per IP and per identity key
const hits = new Map();
function limited(key, max) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(key, list);
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
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

let handlers;
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const op = new URL(req.url, 'http://x').searchParams.get('op') || '';
  if (op === 'products') return send(res, 200, listProducts());
  if (!LIMITS[op]) return send(res, 404, { error: 'not-found' });
  if (req.method !== 'POST') return send(res, 405, { error: 'method-not-allowed' });
  const ip =
    String(req.headers['x-real-ip'] || req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim() || 'unknown';
  if (limited(`${op}|ip|${ip}`, LIMITS[op])) return send(res, 429, { error: 'rate-limited' });
  const body = await readJson(req);
  if (body === null) return send(res, 400, { error: 'invalid-json' });
  const who = String(body.identityKey || '').toLowerCase();
  if (who && limited(`${op}|key|${who}`, LIMITS[op])) return send(res, 429, { error: 'rate-limited' });
  if (!handlers) {
    const store = themeOrderStore();
    const buyStore = themeBuyStore();
    const depositStore = themeDepositStore();
    const ledger = paidTxidStore();
    if (!store || !buyStore || !depositStore || !ledger) return send(res, 503, { error: 'not_configured' });
    const deps = { ledger, rate: () => chain.bsvUsd(), broadcast: arcBroadcast(), ...agentHandlerOptions() };
    handlers = makeAgentBuyHandlers({
      buy: makeThemeBuyHandlers({ store: buyStore, ...deps }),
      order: makeThemeOrderHandlers({ store, ...deps }),
      deposit: makeThemeDepositHandlers({ store: depositStore, ...deps }),
    });
  }
  try {
    const [status, out] = op === 'quote' ? await handlers.quote(body) : await handlers.claim(body);
    return send(res, status, out);
  } catch (e) {
    console.error('agent-buy error', op, String(e && e.message ? e.message : e).slice(0, 200));
    return send(res, 500, { error: 'server-error' });
  }
};
