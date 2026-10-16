// Paymail display names (owner, 15 Oct 2026): a person's name, separate from the paymail.
// mike@bwalletx.com can show as "Mike Smith". Never blank, so a sender's wallet never says "anonymous".
//
// Storage: bwallet_paymail_aliases.display_name, kept the SAME on every row of one identity key
// (a wallet with several names is one person). setDisplayName writes all rows for the key; a new
// name on a wallet inherits the wallet's name. No new table, so no migration.
'use strict';

const MAX = 64;
/** Default names nobody chose ("Anonymous", "Account 1", the app name): never stored or shown. */
const PLACEHOLDER_RE = /^(account\s*\d*|anonymous|anon|bwallet|bwalletx|yours|wallet|unknown|user)$/i;
// Control, format (zero-width, bidi overrides) and line/paragraph separators.
const CONTROL_RE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
// Anything that dresses a name up as a paymail, a domain or a badge.
const IMPERSONATE_RES = [
  /@\s*\S*/g, // "@bwalletx", "mike@bwalletx.com"
  /\b[\w-]+\.(com|net|org|io|app|xyz|online|website|me|co|uk)\b/gi,
  /\bb?wallet\s*x\b/gi,
  /\bverified\b/gi,
  /\bofficial\b/gi,
  /\b(admin|support|staff|moderator)\b/gi,
  /[\u2713\u2714\u2705\u2611\u{1F512}\u{1F6E1}]/gu, // check marks, lock, shield
];

/** The alias as a name: "mike" → "Mike", "b0asex.x" → "B0asex", "mary_jo" → "Mary jo". */
function defaultDisplayName(alias) {
  const base = String(alias || '')
    .split('@')[0]
    .replace(/\.(x|gmail)$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : '';
}

/**
 * A name as typed → what is stored: trimmed, no control characters, no "@bwalletx" / "verified"
 * style impersonation, single spaces, at most 64 characters. '' when nothing usable is left.
 */
function cleanDisplayName(raw) {
  let s = String(raw ?? '')
    .normalize('NFC')
    .replace(CONTROL_RE, '');
  for (const re of IMPERSONATE_RES) s = s.replace(re, ' ');
  s = s
    .replace(/[<>]/g, '')
    .replace(/[([{]\s*[)\]}]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—·|:,.]+|[\s\-–—·|:,.]+$/g, '')
    .trim();
  if (PLACEHOLDER_RE.test(s)) return '';
  return Array.from(s).slice(0, MAX).join('').trim();
}

/** The name a lookup returns: the stored one if real, else the alias as a name. Never blank for a real alias. */
function shownDisplayName(stored, alias) {
  return cleanDisplayName(stored) || defaultDisplayName(alias) || String(alias || '');
}

module.exports = { MAX, cleanDisplayName, defaultDisplayName, shownDisplayName, PLACEHOLDER_RE };
