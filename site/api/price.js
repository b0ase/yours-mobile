// GET /api/price[?m=<ISO minute start>]: one shared BSV/USD price per minute for every bWalletX device.
// { bsvUsd, minute, source: 'whatsonchain', sourceTime, fetchedAt[, stale] }. Logic and cache rules: site/lib/sharedPrice.js.
'use strict';
const { makeSharedPrice } = require('../lib/sharedPrice');

let price;

// Per-IP limit, like the site's other endpoints. Devices ask once a minute and most answers come from the CDN, so this
// only bites a client hammering the function directly.
const LIMIT_PER_MIN = 60;
const hits = new Map();
function limited(ip, max = LIMIT_PER_MIN) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
}

/** The only query parameter: anything else is refused, so junk URLs can't each become a CDN entry or a WoC call. */
const PARAMS = new Set(['m']);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.setHeader('Cache-Control', 'no-store');
    return res.end(JSON.stringify({ error: 'method-not-allowed' }));
  }
  const q = new URL(req.url || '/', 'http://x').searchParams;
  const keys = [...q.keys()];
  if (keys.some((k) => !PARAMS.has(k)) || q.getAll('m').length > 1) {
    res.statusCode = 400;
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    return res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ error: 'bad-query' }));
  }
  const ip =
    String(req.headers['x-real-ip'] || req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim() || 'unknown';
  if (limited(ip)) {
    res.statusCode = 429;
    res.setHeader('Cache-Control', 'no-store');
    return res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ error: 'rate-limited' }));
  }
  if (!price) price = makeSharedPrice();
  const m = q.get('m');
  const [status, body, cacheControl] = await price(m);
  res.statusCode = status;
  res.setHeader('Cache-Control', cacheControl);
  return res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
};

// Tests: swap the price source (fake WhatsOnChain / clock) and clear the per-IP counts.
module.exports.__setPriceForTests = (p) => {
  price = p;
  hits.clear();
};
