// Anti-impersonation (owner, 28 Oct 2026: "the fake and phishing problems are real, fix those first").
// Look-alike handles and display names that pose as bWalletX / bCorp are refused at register and
// set-name. Existing records are untouched: these run only on new claims and new names.
// src/mobile/bmail/senderTrust.ts mirrors BRANDS and lookalike() for the bMail sender warning.
'use strict';

/** Our brands. `b` is only matched as a whole word (it is too short to match inside other words). */
const BRANDS = Object.freeze([
  'bwallet',
  'bwalletx',
  'bcorp',
  'bitcoincorp',
  'bchat',
  'bchatx',
  'bsignx',
  'bgitx',
  'bmail',
  'bmailx',
  'b',
  'kintsugi',
]);
/** Words that dress a brand up as a help desk: `bwalletsupport`, `bcorp-official`, `helpbchat`. */
const ROLE_WORDS = Object.freeze([
  'support',
  'help',
  'helpdesk',
  'official',
  'team',
  'staff',
  'admin',
  'security',
  'verify',
  'wallet',
  'service',
  'care',
  'desk',
  'billing',
  'refund',
  'recovery',
]);
/** Role words that, next to a brand in a display name, read as staff ("bCorp Support"). */
const NAME_ROLE_WORDS = Object.freeze(['support', 'official', 'staff', 'admin']);

/**
 * The look-alike fold: lower case, NFKC, zero-width removed, 0→o 1→l 3→e 5→s 4→a, rn→m, vv→w,
 * and `-` / `_` dropped. Two names that fold the same look the same to a reader.
 */
function lookalike(s, one = 'l') {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')
    .toLowerCase()
    .replace(/[-_]/g, '')
    .replace(/0/g, 'o')
    .replace(/1/g, one)
    .replace(/3/g, 'e')
    .replace(/5/g, 's')
    .replace(/4/g, 'a')
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w');
}
/** `1` reads as both `l` and `i`, so every check runs on both folds and refuses if either matches. */
const ONE_AS = ['l', 'i'];
const lookalikes = (s) => [...new Set(ONE_AS.map((one) => lookalike(s, one)))];

const FOLDED_BRANDS = new Set(BRANDS);
const BRAND_ROLE = new Set();
for (const b of BRANDS)
  for (const r of ROLE_WORDS) {
    BRAND_ROLE.add(b + r);
    BRAND_ROLE.add(r + b);
  }

/** A folded name is a brand, or a brand with a role word before or after it. */
const isBrandish = (folded) => FOLDED_BRANDS.has(folded) || BRAND_ROLE.has(folded);

/**
 * True when a handle (social suffix stripped) folds to one of `reserved` or is brand + role word.
 * `reserved` is the reserved-name set (plain names; folded here).
 */
function lookalikeReserved(alias, reserved) {
  const base = String(alias || '').replace(/\.(x|gmail)$/, '');
  const folds = lookalikes(base);
  if (folds.some(isBrandish)) return true;
  if (folds.length === 1 && folds[0] === base) return false; // nothing folded: plain RESERVED covers it
  for (const r of reserved) if (lookalikes(r).some((x) => folds.includes(x))) return true;
  return false;
}

/**
 * A display name that poses as us: any word (or two adjacent words joined: "B Wallet", "Bitcoin Corp")
 * that folds to a brand, a brand + role word, or starts with a brand of 5+ letters ("bwalletx2").
 * A lone `b` counts only next to a role word ("b support") or as the whole name, so "Mike B" is fine.
 */
function brandInDisplayName(name) {
  return ONE_AS.some((one) => brandWords(name, one));
}
function brandWords(name, one) {
  const words = String(name ?? '')
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((w) => lookalike(w, one))
    .filter(Boolean);
  if (words.length === 1 && words[0] === 'b') return true;
  const long = BRANDS.filter((b) => b.length >= 5);
  const hit = (w) => (w !== 'b' && isBrandish(w)) || long.some((b) => w.startsWith(b));
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (hit(w)) return true;
    const next = words[i + 1];
    if (next === undefined) continue;
    if (hit(w + next)) return true;
    // "b support", "official b", "b team" (all role words for the `b` case is too broad: keep the four).
    if ((w === 'b' && NAME_ROLE_WORDS.includes(next)) || (next === 'b' && NAME_ROLE_WORDS.includes(w))) return true;
  }
  return false;
}

const DISPLAY_NAME_MSG = 'That name looks like bWalletX or The Bitcoin Corporation. Please choose another.';

module.exports = {
  BRANDS,
  ROLE_WORDS,
  NAME_ROLE_WORDS,
  lookalike,
  lookalikes,
  lookalikeReserved,
  brandInDisplayName,
  isBrandish,
  DISPLAY_NAME_MSG,
};
