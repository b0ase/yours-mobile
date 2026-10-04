// bWalletX Continue with X / Google (lib/social.js). Routed by vercel.json:
//   POST /api/social/start, GET /api/social/{x,google}/callback, POST /api/social/preview
'use strict';
const social = require('../lib/social');

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = typeof req.body === 'string' ? req.body : '';
  if (!raw) for await (const c of req) raw += c;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}
const send = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const q = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  try {
    if (q.op === 'start' && req.method === 'POST') return send(res, ...social.start(await readJson(req)));
    if (q.op === 'preview' && req.method === 'POST') {
      const b = await readJson(req);
      const p = social.openTicket(b.ticket, b.secret);
      return p ? send(res, 200, p) : send(res, 401, { error: 'That sign-in has expired. Please try again.' });
    }
    if ((q.op === 'x' || q.op === 'google') && req.method === 'GET') {
      const to = await social.callback(q.op, q);
      res.statusCode = 302;
      res.setHeader('Location', to);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      return res.end();
    }
    return send(res, 404, { error: 'not-found' });
  } catch (e) {
    return send(res, 500, { error: e instanceof Error ? e.message : 'error' });
  }
};
