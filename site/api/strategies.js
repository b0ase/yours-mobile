// Exchange › Strategies key service and catalogue (lib/strategyKeys.js).
//   GET  /api/strategies                       → { strategies: [{ origin, envelope (public), sold, createdAt }] }
//   GET  /api/strategies?origin=<origin>       → { strategy: { origin, envelope (full, encrypted), sold } }
//   POST /api/strategies { action:'publish', outpoint, key, message, pubkey_hex, signature }
//   POST /api/strategies { action:'unlock',  outpoint, message, pubkey_hex, signature } → { key }
// Env (Vercel only, never in git): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRATEGY_KEY_SECRET.
const crypto = require('node:crypto');
const K = require('../lib/strategyKeys');

const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 30;
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > MAX_PER_WINDOW;
}

const send = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
};

async function db(path, init = {}) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error('unconfigured');
  return fetch(`${base.replace(/\/$/, '')}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
}
const rows = async (path) => {
  const r = await db(path);
  if (!r.ok) throw new Error(`db ${r.status}`);
  return r.json();
};
const soldCount = async (keyHash) =>
  (await rows(`bwallet_strategy_copies?select=origin&key_hash=eq.${keyHash}`)).length;

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = typeof req.body === 'string' ? req.body : '';
  if (!raw) for await (const c of req) raw += c;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

async function list(req, res) {
  const origin = K.normOutpoint(new URL(req.url, 'http://x').searchParams.get('origin'));
  if (origin) {
    if (!K.OUTPOINT.test(origin)) return send(res, 400, { error: 'Bad origin' });
    const [s] = await rows(`bwallet_strategies?select=origin,envelope,created_at,key_hash&origin=eq.${origin}`);
    if (!s) return send(res, 404, { error: 'Not found' });
    return send(res, 200, {
      strategy: { origin: s.origin, envelope: s.envelope, sold: await soldCount(s.key_hash), createdAt: s.created_at },
    });
  }
  const [all, copies] = await Promise.all([
    rows('bwallet_strategies?select=origin,envelope,created_at,key_hash&order=created_at.desc&limit=200'),
    rows('bwallet_strategy_copies?select=key_hash'),
  ]);
  const sold = new Map();
  for (const c of copies) sold.set(c.key_hash, (sold.get(c.key_hash) || 0) + 1);
  return send(res, 200, {
    strategies: all.map((s) => ({
      origin: s.origin,
      envelope: K.publicEnvelope(s.envelope),
      sold: sold.get(s.key_hash) || 0,
      createdAt: s.created_at,
    })),
  });
}

async function publish(b, res) {
  const outpoint = K.normOutpoint(b.outpoint);
  if (!K.OUTPOINT.test(outpoint)) return send(res, 400, { error: 'Bad outpoint' });
  const proof = K.verifyProof('publish', outpoint, b);
  if (!proof.ok) return send(res, 401, { error: proof.error });
  const own = await K.owns(outpoint, proof.address);
  if (!own.ok) return send(res, 403, { error: own.error });
  const at = await K.envelopeAt(outpoint);
  if (!at) return send(res, 400, { error: 'That output isn’t a strategy inscription' });
  const { env } = at;
  // Authorship = holding the content key (sha256 must match keyHash below) + owning this fresh copy.
  if (outpoint !== ((await K.chain.origin(outpoint)) || outpoint))
    return send(res, 400, { error: 'Publish from the newly minted copy' });
  const keyB64 = String(b.key || '');
  const hash = crypto.createHash('sha256').update(Buffer.from(keyB64, 'base64')).digest('hex');
  if (hash !== env.keyHash) return send(res, 400, { error: 'The key doesn’t match this strategy' });
  const r = await db('bwallet_strategies', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      key_hash: env.keyHash,
      origin: outpoint,
      envelope: env,
      author_address: proof.address,
      key_enc: K.sealKey(keyB64),
    }),
  });
  if (r.status === 409) return send(res, 409, { error: 'Already published' });
  if (!r.ok) return send(res, 500, { error: 'Could not save' });
  return send(res, 200, { ok: true, origin: outpoint });
}

async function unlock(b, res) {
  const outpoint = K.normOutpoint(b.outpoint);
  if (!K.OUTPOINT.test(outpoint)) return send(res, 400, { error: 'Bad outpoint' });
  const proof = K.verifyProof('unlock', outpoint, b);
  if (!proof.ok) return send(res, 401, { error: proof.error });
  const own = await K.owns(outpoint, proof.address);
  if (!own.ok) return send(res, 403, { error: own.error });
  const origin = (await K.chain.origin(outpoint)) || outpoint;
  const at = await K.envelopeAt(origin);
  if (!at) return send(res, 400, { error: 'That isn’t a strategy NFT' });
  const { env, tx } = at;
  const [s] = await rows(`bwallet_strategies?select=origin,key_enc,envelope&key_hash=eq.${env.keyHash}`);
  if (!s) return send(res, 404, { error: 'This strategy isn’t published' });

  if (origin !== s.origin) {
    const [known] = await rows(`bwallet_strategy_copies?select=origin&origin=eq.${origin}`);
    if (!known) {
      // A new copy: its mint must have paid the author, and the edition must not be sold out. The terms
      // come from the PUBLISHED envelope: a re-inscription with the same keyHash can't lower the price.
      const sale = s.envelope.sale;
      const paid = K.paidTo(tx, sale.payTo);
      const rate = await K.chain.bsvUsd();
      if (!(rate > 0)) return send(res, 503, { error: 'No BSV price right now; try again shortly' });
      const need = Math.floor((sale.priceUsd / rate) * 1e8 * K.PRICE_TOLERANCE);
      if (paid < need) return send(res, 402, { error: 'This copy wasn’t paid for' });
      if ((await soldCount(env.keyHash)) >= sale.copies) return send(res, 410, { error: 'Sold out' });
      const r = await db('bwallet_strategy_copies', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ origin, key_hash: env.keyHash, paid_sats: paid }),
      });
      if (!r.ok && r.status !== 409) return send(res, 500, { error: 'Could not record the copy' });
    }
  }
  return send(res, 200, { key: K.openKey(s.key_enc), origin });
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') return await list(req, res);
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    const ip =
      String(req.headers['x-forwarded-for'] || '')
        .split(',')[0]
        .trim() || 'unknown';
    if (limited(ip)) return send(res, 429, { error: 'Too many requests' });
    const b = await readBody(req);
    if (b.action === 'publish') return await publish(b, res);
    if (b.action === 'unlock') return await unlock(b, res);
    return send(res, 400, { error: 'Unknown action' });
  } catch (e) {
    console.error('strategies error', e instanceof Error ? e.message : 'unknown');
    return send(res, 500, { error: 'Something went wrong' });
  }
};
