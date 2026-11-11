// Names held for an X account (owner, 11 Nov 2026; migrations/20261111_paymail_x_holds.sql).
//
// A hold keeps one plain alias (e.g. `kurt`) for ONE X account, named by X's numeric user id. Only a wallet that
// proves that X account may register the alias, and it pays no name fee. The proof is either:
//   - link:   the wallet's identity key has a verified X link (Link your accounts, lib/socialLinks.js): the row's
//             `account` is sha256('x:' + X user id), written only after an X sign-in ticket opened AND the
//             identity key signed the link; or
//   - ticket: the register request carries a fresh Continue with X ticket + secret (lib/social.js) for that id.
// ⚠ NEVER the @name. X @names change hands; the numeric id does not. x_handle is kept for words on a page only.
//
// Pure rules + one async proof check over an injected store, so it is unit-testable (test/xHolds.test.js).
'use strict';
const crypto = require('crypto');
const social = require('./social');

const X_ID_RE = /^[0-9]{1,25}$/;
const X_HANDLE_RE = /^[a-z0-9_]{1,15}$/;
const PUBKEY_RE = /^0[23][0-9a-f]{64}$/;
/** A new hold lasts this long unless the admin says otherwise (the 90-day rename hold's length). */
const DEFAULT_HOLD_DAYS = 90;
const MAX_HOLD_DAYS = 365;

/** The `account` a verified X link stores for this X user id (same as lib/socialLinks.js). */
const xAccountHash = (xUserId) => crypto.createHash('sha256').update(`x:${xUserId}`, 'utf8').digest('hex');

/** Live: not released, and either claimed (the name is then registered anyway) or not past its expiry. */
function holdActive(hold, nowMs = Date.now()) {
  if (!hold || !X_ID_RE.test(String(hold.x_user_id || ''))) return false;
  if (hold.released_at) return false;
  if (hold.claimed_at) return true;
  return !hold.expires_at || Date.parse(hold.expires_at) > nowMs;
}

const at = (h) => (X_HANDLE_RE.test(String(h || '')) ? `@${h}` : 'someone on X');
/** The plain refusal everybody else gets. */
const holdMessage = (hold) =>
  `This name is held for ${at(hold && hold.x_handle)}. Only that X account can claim it: sign in with X in bWalletX (Settings › Link your accounts) first.`;
/** What the holder sees before claiming. */
const holderMessage = (hold) => `Held for you (${at(hold && hold.x_handle)} on X). Free to claim.`;

/**
 * Does this wallet prove the hold's X account? Resolves { ok: true, via } or { ok: false, error }.
 * `social` is the optional { ticket, secret } of a Continue with X sign-in. Any failure is "no".
 */
async function proveHold({ hold, identityKey, social: proof, store, env = process.env, now = Date.now() }) {
  const want = String((hold && hold.x_user_id) || '');
  const key = String(identityKey || '').toLowerCase();
  if (!X_ID_RE.test(want) || !PUBKEY_RE.test(key)) return { ok: false, error: holdMessage(hold) };
  if (proof && proof.ticket && proof.secret) {
    const p = social.openTicket(proof.ticket, proof.secret, env, now);
    if (p && p.provider === 'x' && String(p.id || '') === want) return { ok: true, via: 'ticket' };
  }
  if (store && store.listSocialLinks) {
    const links = await store.listSocialLinks(key).catch(() => []);
    const account = xAccountHash(want);
    if (
      (links || []).some(
        (l) => l.provider === 'x' && l.account === account && String(l.identity_key || '').toLowerCase() === key,
      )
    )
      return { ok: true, via: 'link' };
  }
  return { ok: false, error: holdMessage(hold) };
}

/** Is the hold's X account linked to this key? (the claim screen's GET check: no ticket there). */
async function keyHoldsIt(hold, identityKey, store) {
  return (await proveHold({ hold, identityKey, store })).ok;
}

/**
 * The admin's new hold, checked. Returns { row } or { error }. `validAlias` is paymail.js's (format + reserved +
 * look-alike rules): a hold is for an ordinary name, never a reserved one.
 */
function holdRow(body, { validAlias, now = Date.now() }) {
  const b = body || {};
  const alias = String(b.alias || '')
    .trim()
    .toLowerCase();
  if (alias.includes('.')) return { error: 'A held name is a plain name (no dot)' };
  const bad = validAlias(alias);
  if (bad) return { error: bad };
  const xUserId = String(b.x_user_id ?? b.xUserId ?? '').trim();
  if (!X_ID_RE.test(xUserId)) return { error: 'x_user_id must be the numeric X user id' };
  const xHandle = String(b.x_handle ?? b.xHandle ?? '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase();
  if (xHandle && !X_HANDLE_RE.test(xHandle)) return { error: 'x_handle must be an X @name' };
  const days = b.days === undefined || b.days === null ? DEFAULT_HOLD_DAYS : Number(b.days);
  // 0 = no end.
  if (!Number.isInteger(days) || days < 0 || days > MAX_HOLD_DAYS)
    return { error: `days must be a whole number from 0 to ${MAX_HOLD_DAYS}` };
  const note = String(b.note || '').slice(0, 200);
  return {
    row: {
      alias,
      x_user_id: xUserId,
      x_handle: xHandle,
      note,
      expires_at: days ? new Date(now + days * 86_400_000).toISOString() : null,
    },
  };
}

/** What anyone may read about a hold (the claim page): never the X user id, never the claiming key. */
function publicHold(alias, hold, nowMs = Date.now()) {
  if (!hold) return { alias, status: 'none' };
  const status = hold.released_at ? 'none' : hold.claimed_at ? 'claimed' : holdActive(hold, nowMs) ? 'held' : 'expired';
  if (status === 'none') return { alias, status };
  return {
    alias,
    status,
    xHandle: X_HANDLE_RE.test(String(hold.x_handle || '')) ? hold.x_handle : null,
    expiresAt: status === 'held' ? hold.expires_at || null : null,
  };
}

module.exports = {
  DEFAULT_HOLD_DAYS,
  MAX_HOLD_DAYS,
  xAccountHash,
  holdActive,
  holdMessage,
  holderMessage,
  proveHold,
  keyHoldsIt,
  holdRow,
  publicHold,
};
