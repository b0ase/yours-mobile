// Theme Store catalog (read-only, docs/THEME-STORE-PLAN.md step 2). GET /api/themes[?tier=free|premium|holder|edition]
// Serves site/api/themes.json: the bundled packs in the bwx-theme/1 format (src/mobile/theme/themePack.ts), kept
// equal to the wallet's own packs by src/mobile/theme/themePack.test.ts. No payments, no writes, no secrets.
'use strict';
const catalog = require('./themes.json');

const TIERS = new Set(['free', 'premium', 'holder', 'edition']);

module.exports = function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: 'method-not-allowed' }));
  }
  const tier = new URL(req.url || '/', 'http://x').searchParams.get('tier');
  if (tier && !TIERS.has(tier)) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'bad-tier' }));
  }
  const packs = tier ? catalog.packs.filter((p) => p.tier === tier) : catalog.packs;
  res.statusCode = 200;
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');
  return res.end(JSON.stringify({ format: catalog.format, tiers: catalog.tiers, packs }));
};
