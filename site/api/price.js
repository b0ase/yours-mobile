// GET /api/price[?m=<ISO minute start>]: one shared BSV/USD price per minute for every bWalletX device.
// { bsvUsd, minute, source: 'whatsonchain', sourceTime, fetchedAt[, stale] }. Logic and cache rules: site/lib/sharedPrice.js.
'use strict';
const { makeSharedPrice } = require('../lib/sharedPrice');

let price;

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
  if (!price) price = makeSharedPrice();
  const m = new URL(req.url || '/', 'http://x').searchParams.get('m');
  const [status, body, cacheControl] = await price(m);
  res.statusCode = status;
  res.setHeader('Cache-Control', cacheControl);
  return res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
};

// Tests: swap the price source (fake WhatsOnChain / clock).
module.exports.__setPriceForTests = (p) => {
  price = p;
};
