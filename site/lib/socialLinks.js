// Publish "Link your accounts" links (owner, 18 Oct 2026; migrations/20261018_social_links.sql).
//   link   POST {ticket, secret, identityKey, timestamp, signature, fields:{provider, account, handle}}
//          The ticket must open with the secret (lib/social.js: the provider proved the account), the fields
//          must match what it proves, and the identity key must have signed them ("link", lib/paymail.js).
//   links  GET ?key=<identityKey> → the wallet's public links (badges anyone can re-verify).
// Google: only the hashed account id is kept; the address never reaches the table.
'use strict';
const crypto = require('crypto');
const social = require('./social');
const { verifySigned } = require('./paymail');

const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
/** Same rule as the app (src/mobile/social/links.ts linkHandle): never anything from an email. */
function linkHandle(provider, name) {
  const n = String(name || '')
    .trim()
    .replace(/^[@$]/, '')
    .toLowerCase();
  if (provider === 'google' || provider === 'linkedin' || n.includes('@')) return '';
  return /^[a-z0-9_.-]{1,39}$/.test(n) ? n : '';
}

async function link(body, store, env = process.env, now = Date.now()) {
  if (!store) return [503, { error: 'Links are not stored on this server yet' }];
  const p = social.openTicket(body.ticket, body.secret, env, now);
  if (!p || !p.id) return [401, { error: 'That link has expired. Please try again.' }];
  const f = body.fields || {};
  const want = { provider: p.provider, account: sha(`${p.provider}:${p.id}`), handle: linkHandle(p.provider, p.name) };
  if (f.provider !== want.provider || f.account !== want.account || (f.handle || '') !== want.handle)
    return [400, { error: 'The link does not match the verified account' }];
  const bad = await verifySigned({ ...body, fields: want }, 'link', now);
  if (bad) return [401, { error: bad }];
  await store.putSocialLink({
    ...want,
    identity_key: String(body.identityKey).toLowerCase(),
    signature: String(body.signature),
    signed_at: new Date(Number(body.timestamp)).toISOString(),
  });
  return [200, { ok: true }];
}

async function links(key, store) {
  const k = String(key || '').toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(k)) return [400, { error: 'key must be a compressed public key' }];
  if (!store) return [200, { links: [] }];
  const rows = await store.listSocialLinks(k);
  return [
    200,
    {
      links: rows.map((r) => ({
        provider: r.provider,
        account: r.account,
        handle: r.handle,
        identityKey: r.identity_key,
        timestamp: String(Date.parse(r.signed_at)),
        signature: r.signature,
      })),
      scheme: 'bwallet-paymail/v1 link; BRC-43 protocol [2,"bwallet paymail"] keyID "1", counterparty anyone',
    },
  ];
}

module.exports = { link, links, linkHandle };
