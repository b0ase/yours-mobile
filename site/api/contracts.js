// Exchange › Contracts catalogue (lib/contracts.js; chain checks shared with strategies in lib/strategyKeys.js).
//   GET  /api/contracts                    → { contracts: [{ origin, envelope, sold, createdAt }] }
//   GET  /api/contracts?origin=<origin>    → { contract: { origin, envelope, sold, createdAt } }
//   POST { action:'publish', outpoint, message, pubkey_hex, signature }   the author's freshly minted copy
//   POST { action:'claim',   outpoint, message, pubkey_hex, signature }   a buyer's copy: checked as paid, counted
// Contracts are public (not encrypted): the catalogue only vouches that a copy is genuine and paid for.
// Env (Vercel only): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
const K = require('../lib/strategyKeys');
const { CONTRACT_TYPE, parseContractEnvelope } = require('../lib/contracts');

const WINDOW_MS = 10 * 60 * 1000;
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 30;
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
const at = (origin) => K.envelopeAt(origin, K.chain, CONTRACT_TYPE, parseContractEnvelope);

async function list(req, res) {
  const origin = K.normOutpoint(new URL(req.url, 'http://x').searchParams.get('origin'));
  const [all, copies] = await Promise.all([
    rows(
      `bwallet_contracts?select=origin,envelope,body,created_at${origin ? `&origin=eq.${origin}` : ''}&order=created_at.desc&limit=200`,
    ),
    rows('bwallet_contract_copies?select=contract_origin'),
  ]);
  const sold = new Map();
  for (const c of copies) sold.set(c.contract_origin, (sold.get(c.contract_origin) || 0) + 1);
  // `body` = the exact inscribed text: buyers inscribe it byte for byte, so their copy's hash matches.
  const out = all.map((c) => ({
    origin: c.origin,
    envelope: c.envelope,
    body: c.body,
    sold: sold.get(c.origin) || 0,
    createdAt: c.created_at,
  }));
  if (origin) return out[0] ? send(res, 200, { contract: out[0] }) : send(res, 404, { error: 'Not found' });
  return send(res, 200, { contracts: out });
}

async function proven(b, action) {
  const outpoint = K.normOutpoint(b.outpoint);
  if (!K.OUTPOINT.test(outpoint)) return { error: [400, 'Bad outpoint'] };
  const proof = K.verifyProof(action, outpoint, b);
  if (!proof.ok) return { error: [401, proof.error] };
  const own = await K.owns(outpoint, proof.address);
  if (!own.ok) return { error: [403, own.error] };
  return { outpoint, address: proof.address };
}

async function publish(b, res) {
  const p = await proven(b, 'publish');
  if (p.error) return send(res, p.error[0], { error: p.error[1] });
  if (p.outpoint !== ((await K.chain.origin(p.outpoint)) || p.outpoint))
    return send(res, 400, { error: 'Publish from the newly minted copy' });
  const a = await at(p.outpoint);
  if (!a) return send(res, 400, { error: 'That output isn’t a contract inscription' });
  const r = await db('bwallet_contracts', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      origin: p.outpoint,
      body_hash: a.bodyHash,
      body: a.body,
      envelope: a.env,
      author_address: p.address,
    }),
  });
  if (r.status === 409) return send(res, 409, { error: 'Already published' });
  if (!r.ok) return send(res, 500, { error: 'Could not save' });
  return send(res, 200, { ok: true, origin: p.outpoint });
}

async function claim(b, res) {
  const p = await proven(b, 'unlock');
  if (p.error) return send(res, p.error[0], { error: p.error[1] });
  const origin = (await K.chain.origin(p.outpoint)) || p.outpoint;
  const a = await at(origin);
  if (!a) return send(res, 400, { error: 'That isn’t a contract NFT' });
  const [c] = await rows(`bwallet_contracts?select=origin,envelope&body_hash=eq.${a.bodyHash}`);
  if (!c) return send(res, 404, { error: 'This contract isn’t published (or the copy was altered)' });
  if (origin === c.origin) return send(res, 200, { ok: true, contract: c.origin, original: true });
  const [known] = await rows(`bwallet_contract_copies?select=origin&origin=eq.${origin}`);
  if (!known) {
    const sale = c.envelope.sale;
    const paid = K.paidTo(a.tx, sale.payTo);
    if (sale.priceUsd > 0) {
      const rate = await K.chain.bsvUsd();
      if (!(rate > 0)) return send(res, 503, { error: 'No BSV price right now; try again shortly' });
      if (paid < Math.floor((sale.priceUsd / rate) * 1e8 * K.PRICE_TOLERANCE))
        return send(res, 402, { error: 'This copy wasn’t paid for' });
    }
    const sold = (await rows(`bwallet_contract_copies?select=origin&contract_origin=eq.${c.origin}`)).length;
    if (sold >= sale.copies) return send(res, 410, { error: 'Sold out' });
    const r = await db('bwallet_contract_copies', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ origin, contract_origin: c.origin, owner_address: p.address, paid_sats: paid }),
    });
    if (!r.ok && r.status !== 409) return send(res, 500, { error: 'Could not record the copy' });
  }
  return send(res, 200, { ok: true, contract: c.origin, original: false });
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
    if (b.action === 'claim') return await claim(b, res);
    return send(res, 400, { error: 'Unknown action' });
  } catch (e) {
    console.error('contracts error', e instanceof Error ? e.message : 'unknown');
    return send(res, 500, { error: 'Something went wrong' });
  }
};
