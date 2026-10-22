// Theme Store catalog (read-only, docs/THEME-STORE-PLAN.md step 2). GET /api/themes[?tier=free|premium|holder|edition]
// Serves site/lib/themes.json: the bundled packs in the bwx-theme/1 format (src/mobile/theme/themePack.ts), kept
// equal to the wallet's own packs by src/mobile/theme/themePack.test.ts. No payments, no writes, no secrets.
// GET /api/theme-sites (rewritten to ?list=sites) serves the family sites that may offer a theme (site/lib/themeSites.js).
'use strict';
const catalog = require('../lib/themes.json');
const { THEME_SITES } = require('../lib/themeSites');

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
  const q = new URL(req.url || '/', 'http://x').searchParams;
  if (q.get('list') === 'sites') {
    res.statusCode = 200;
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');
    return res.end(JSON.stringify({ sites: THEME_SITES }));
  }
  const tier = q.get('tier');
  if (tier && !TIERS.has(tier)) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'bad-tier' }));
  }
  const packs = tier ? catalog.packs.filter((p) => p.tier === tier) : catalog.packs;
  res.statusCode = 200;
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');
  return res.end(JSON.stringify({ format: catalog.format, tiers: catalog.tiers, packs }));
};
