// POST /api/waitlist — bWallet testing waitlist signup.
// Env (Vercel only, never in git): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PLATFORMS = new Set(['ios', 'android', 'either']);
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
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/json')) {
    try {
      return JSON.parse(raw || '{}');
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function reply(req, res, status, ok, message) {
  const wantsJson = String(req.headers.accept || '').includes('application/json');
  if (wantsJson) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok, message }));
  }
  // No-JS form post: bounce back to the waitlist section.
  res.statusCode = 303;
  res.setHeader('Location', `/?waitlist=${ok ? 'ok' : 'error'}#waitlist`);
  return res.end();
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return reply(req, res, 405, false, 'Method not allowed.');
  }
  const ip =
    String(req.headers['x-forwarded-for'] || '')
      .split(',')[0]
      .trim() || 'unknown';
  if (limited(ip)) return reply(req, res, 429, false, 'Too many attempts. Please try again later.');

  const body = await readBody(req);
  // Honeypot: bots fill it, humans never see it. Pretend success.
  if (body.company) return reply(req, res, 200, true, "You're on the list.");

  const email = String(body.email || '')
    .trim()
    .toLowerCase();
  const platform = String(body.platform || 'either')
    .trim()
    .toLowerCase();
  if (!email || email.length > 254 || !EMAIL_RE.test(email))
    return reply(req, res, 400, false, 'Please enter a valid email address.');
  if (!PLATFORMS.has(platform)) return reply(req, res, 400, false, 'Please choose iPhone, Android or Either.');

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return reply(req, res, 500, false, 'Signup is unavailable right now. Please try again later.');

  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/rest/v1/bwallet_waitlist?on_conflict=email`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=ignore-duplicates,return=minimal',
      },
      body: JSON.stringify({
        email,
        platform,
        source: String(body.source || 'site').slice(0, 64),
        user_agent: String(req.headers['user-agent'] || '').slice(0, 512),
      }),
    });
    if (!r.ok && r.status !== 409) {
      console.error('waitlist insert failed', r.status);
      return reply(req, res, 500, false, 'Something went wrong. Please try again later.');
    }
    return reply(req, res, 200, true, "You're on the list. We'll email you when testing opens.");
  } catch (e) {
    console.error('waitlist insert error');
    return reply(req, res, 500, false, 'Something went wrong. Please try again later.');
  }
};
