/**
 * GET /api/geo on web.bwalletx.com → { "country": "GB" } (or null when unknown).
 *
 * First-party region source for the UK financial-promotion gate (src/mobile/region/region.ts). The country is the
 * x-vercel-ip-country header Vercel adds to every request; no third-party IP lookup, nothing logged or stored, no
 * cookies. The web wallet, the Chrome extension and bWalletX Desktop all call this one URL, so it allows any origin.
 * Never cached: a cached answer could hand one visitor's country to another.
 *
 * Plain ESM with no dependencies so it ships both ways web.bwalletx.com deploys: from the repo root on a git build
 * (Vercel builds /api) and from build-web on a CLI upload (vite.config.web.ts copies this file to build-web/api/).
 */
export const countryFromHeader = (value) => {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' && /^[A-Za-z]{2}$/.test(v.trim()) ? v.trim().toUpperCase() : null;
};

export default function handler(req, res) {
  const country = countryFromHeader(req.headers['x-vercel-ip-country']);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.end(req.method === 'OPTIONS' ? '' : JSON.stringify({ country }));
}
