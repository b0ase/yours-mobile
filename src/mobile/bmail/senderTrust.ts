/**
 * bMail sender trust (owner, 28 Oct 2026: "the fake and phishing problems are real, fix those first").
 * Display-only: these never block delivery. Mirrors site/lib/brandGuard.js (BRANDS + the look-alike fold).
 */

/** The Bitcoin Corporation Ltd's identity key (bcorp@bwalletx.com). */
export const BCORP_KEY = '03c96b37e69377c8af33b583067f56444c83a656b05014e8f15003e67250943880';

const BRANDS = [
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
];
const ROLE_WORDS = [
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
];
const NAME_ROLE_WORDS = ['support', 'official', 'staff', 'admin'];

/** 0→o 1→l 3→e 5→s 4→a, rn→m, vv→w, - and _ dropped, lower case. */
export const lookalike = (s: string): string =>
  String(s ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')
    .toLowerCase()
    .replace(/[-_]/g, '')
    .replace(/0/g, 'o')
    .replace(/1/g, 'l')
    .replace(/3/g, 'e')
    .replace(/5/g, 's')
    .replace(/4/g, 'a')
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w');

const BRANDISH = new Set<string>(BRANDS);
for (const b of BRANDS)
  for (const r of ROLE_WORDS) {
    BRANDISH.add(b + r);
    BRANDISH.add(r + b);
  }
const LONG = BRANDS.filter((b) => b.length >= 5);

/**
 * True when a sender label (handle like "bc0rp-support@bwalletx.com", or a display name) poses as us.
 * A lone "b" only counts next to a role word, so "Mike B" is fine.
 */
export function looksLikeBrand(label: string): boolean {
  const local = String(label ?? '')
    .split('@')[0]
    .replace(/\.(x|gmail)$/i, '');
  const words = local
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}_-]+/u)
    .map(lookalike)
    .filter(Boolean);
  if (words.length === 1 && words[0] === 'b') return true;
  const hit = (w: string) => (w !== 'b' && BRANDISH.has(w)) || LONG.some((b) => w.startsWith(b));
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (hit(w)) return true;
    const next = words[i + 1];
    if (next === undefined) continue;
    if (hit(w + next)) return true;
    if ((w === 'b' && NAME_ROLE_WORDS.includes(next)) || (next === 'b' && NAME_ROLE_WORDS.includes(w))) return true;
  }
  return false;
}

export type SenderTrust = 'verified' | 'lookalike' | 'none';

/** Verified when the sender's identity key is bCorp's; a look-alike when its name poses as us. */
export function senderTrust(fromKey: string, label: string): SenderTrust {
  if (String(fromKey || '').toLowerCase() === BCORP_KEY) return 'verified';
  return looksLikeBrand(label) ? 'lookalike' : 'none';
}

const SECRET_RES = [
  /\bseed(\s*phrase|\s*words?)?\b/i,
  /\b(12|twelve|24|twenty[\s-]?four)\s+(secret\s+|recovery\s+|backup\s+)?words\b/i,
  /\brecovery\s+(phrase|words?|key)\b/i,
  /\bmnemonic\b/i,
  /\bprivate\s+key\b/i,
  /\bpass\s?word\b/i,
  /\bpasscode\b/i,
];

/** The letter asks for a seed, 12 words, recovery phrase, private key or password. */
export const asksForSecrets = (text: string): boolean => SECRET_RES.some((re) => re.test(String(text ?? '')));

export const VERIFIED_TEXT = 'Verified · The Bitcoin Corporation';
export const LOOKALIKE_TEXT = 'This sender is NOT bWalletX or bCorp.';
export const SECRETS_TEXT = "bWalletX will never ask for your 12 words or password. Don't reply.";
