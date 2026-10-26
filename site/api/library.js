// Owner-only private music library. Routed by site/vercel.json: POST /api/library/session → ?op=session.
// All checks live in site/lib/library.js. Env (Vercel only): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// LIBRARY_OWNER_ALIAS (optional, default b0asex), LIBRARY_EXTRA_ORIGINS (optional, comma-separated, e.g. the
// chrome-extension://<id> origin). Never logs request bodies or signed URLs.
'use strict';
const { makeLibraryHandler, libraryStorage } = require('../lib/library');
const { supabaseStore } = require('../lib/paymailStore');

/** The wallet's own origins: web, Desktop (Tauri), phone (Capacitor), the sites. Nothing else gets CORS. */
const WALLET_ORIGINS = [
  'https://web.bwalletx.com',
  'https://desktop.bwalletx.com',
  'https://bwalletx.com',
  'https://www.bwalletx.com',
  'https://localhost',
  'capacitor://localhost',
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
  // The bWalletX Chrome extension (its manifest key fixes this ID for every install, store or unpacked).
  'chrome-extension://bombmmcjghjdlbmcclnhjodgcelnehgl',
];
const allowedOrigins = (env = process.env) =>
  new Set([
    ...WALLET_ORIGINS,
    ...String(env.LIBRARY_EXTRA_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^(https|chrome-extension):\/\/[a-z0-9.-]+(:\d+)?$/i.test(s)),
  ]);

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = typeof req.body === 'string' ? req.body : '';
  if (!raw)
    for await (const c of req) {
      raw += c;
      if (raw.length > 8192) return null;
    }
  if (raw.length > 8192) return null;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return null;
  }
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}

let session;
function handlerFor(env = process.env) {
  if (!session)
    session = makeLibraryHandler({
      aliases: supabaseStore(env),
      storage: libraryStorage(env),
      ownerAlias: String(env.LIBRARY_OWNER_ALIAS || 'b0asex').toLowerCase(),
    });
  return session;
}

async function handler(req, res) {
  const origin = String(req.headers.origin || '');
  res.setHeader('Vary', 'Origin');
  if (origin && allowedOrigins().has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const op = new URL(req.url, 'http://x').searchParams.get('op') || '';
  if (op !== 'session') return send(res, 404, { error: 'not-found' });
  if (req.method !== 'POST') return send(res, 405, { error: 'method-not-allowed' });
  const ip =
    String(req.headers['x-real-ip'] || req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim() || 'unknown';
  const body = await readJson(req);
  if (body === null) return send(res, 400, { error: 'invalid-json' });
  try {
    const [status, out] = await handlerFor()(body, ip);
    return send(res, status, out);
  } catch {
    console.error('library error'); // fixed text: never the manifest, paths or signed URLs
    return send(res, 503, { error: 'unavailable' });
  }
}

module.exports = handler;
module.exports.allowedOrigins = allowedOrigins;
module.exports.WALLET_ORIGINS = WALLET_ORIGINS;
