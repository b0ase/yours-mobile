// POST /api/apps-submit — "Add your app to bWallet" (bwalletx.com/apps/add).
// Stores a submission for review; approved apps are added with `pnpm add-app` and ship in the next build.
// Env (Vercel only, never in git): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ADDRESS_RE = /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const CATEGORIES = new Set(['market', 'social', 'media', 'tools', 'money', 'explore', 'learn', 'games']);
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map(); // best-effort, per warm instance

function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > MAX_PER_WINDOW;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = typeof req.body === 'string' ? req.body : '';
  if (!raw) for await (const c of req) raw += c;
  if (String(req.headers['content-type'] || '').includes('application/json')) {
    try {
      return JSON.parse(raw || '{}');
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function reply(req, res, status, ok, message) {
  if (String(req.headers.accept || '').includes('application/json')) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok, message }));
  }
  res.statusCode = 303;
  res.setHeader('Location', `/apps/add?sent=${ok ? 'ok' : 'error'}`);
  return res.end();
}

const clean = (v, max) => String(v || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

/** An https URL on a public host (no IPs, no localhost), normalised to origin + path. */
function appUrl(raw) {
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    const h = u.hostname.toLowerCase();
    if (!h.includes('.') || h === 'localhost' || h.endsWith('.local') || /^[\d.]+$/.test(h) || h.includes(':')) return null;
    return `${u.origin}${u.pathname === '/' ? '' : u.pathname}`.slice(0, 300);
  } catch {
    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return reply(req, res, 405, false, 'Method not allowed.');
  }
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) return reply(req, res, 429, false, 'Too many submissions. Please try again later.');

  const body = await readBody(req);
  if (body.company) return reply(req, res, 200, true, 'Thanks! We review every app and will email you.'); // honeypot

  const url = appUrl(clean(body.url, 300));
  const name = clean(body.name, 40);
  const category = clean(body.category, 20).toLowerCase();
  const description = clean(body.description, 140);
  const email = clean(body.email, 254).toLowerCase();
  const bsvAddress = clean(body.bsv_address, 40);
  if (!url) return reply(req, res, 400, false, 'Enter your app’s https:// address.');
  if (!name) return reply(req, res, 400, false, 'Enter your app’s name.');
  if (!CATEGORIES.has(category)) return reply(req, res, 400, false, 'Choose a category.');
  if (!EMAIL_RE.test(email)) return reply(req, res, 400, false, 'Enter a valid email address.');
  if (bsvAddress && !ADDRESS_RE.test(bsvAddress)) return reply(req, res, 400, false, 'That BSV address doesn’t look right.');

  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return reply(req, res, 500, false, 'Submissions are unavailable right now. Please try again later.');
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}/rest/v1/bwallet_app_submissions`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ url, name, category, description: description || null, email, bsv_address: bsvAddress || null }),
    });
    if (r.status === 409) return reply(req, res, 200, true, 'That app is already waiting for review. We’ll email you.');
    if (!r.ok) {
      console.error('apps-submit insert failed', r.status);
      return reply(req, res, 500, false, 'Something went wrong. Please try again later.');
    }
    return reply(req, res, 200, true, 'Thanks! We review every app and will email you when it’s in bWallet.');
  } catch {
    console.error('apps-submit insert error');
    return reply(req, res, 500, false, 'Something went wrong. Please try again later.');
  }
};
