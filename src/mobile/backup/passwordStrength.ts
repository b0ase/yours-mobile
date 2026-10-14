/**
 * Wallet password strength, checked before an encrypted backup file is made (owner, 14 Oct 2026): the file is
 * only as strong as the password, so a weak one is changed first (Settings › Change password). A plain estimate,
 * no dictionary download: character-pool entropy, with common patterns knocked down.
 */
export type Strength = {
  score: 0 | 1 | 2 | 3 | 4;
  bits: number;
  label: 'Too weak' | 'Weak' | 'Fair' | 'Good' | 'Strong';
};

/** Below this many bits the backup asks for a stronger password first. */
export const MIN_BACKUP_BITS = 50;

const COMMON = [
  'password',
  'passw0rd',
  'qwerty',
  'letmein',
  'welcome',
  'iloveyou',
  'admin',
  'monkey',
  'dragon',
  'bitcoin',
  'satoshi',
  'wallet',
  'bwallet',
  'abc123',
  '123456',
  '111111',
];

const poolSize = (pw: string) => {
  let n = 0;
  if (/[a-z]/.test(pw)) n += 26;
  if (/[A-Z]/.test(pw)) n += 26;
  if (/[0-9]/.test(pw)) n += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) n += 33;
  return n;
};

/** Runs like "aaaa", "1234", "abcd" count as one character each. */
const effectiveLength = (pw: string) => {
  let len = pw.length ? 1 : 0;
  for (let i = 1; i < pw.length; i++) {
    const d = pw.charCodeAt(i) - pw.charCodeAt(i - 1);
    const prev = i > 1 ? pw.charCodeAt(i - 1) - pw.charCodeAt(i - 2) : NaN;
    if (Math.abs(d) <= 1 && d === prev) continue;
    len++;
  }
  return len;
};

export const passwordStrength = (pw: string): Strength => {
  const lower = pw.toLowerCase();
  let bits = effectiveLength(pw) * Math.log2(Math.max(poolSize(pw), 1));
  if (COMMON.some((c) => lower.includes(c))) bits = Math.min(bits, 20);
  bits = Math.round(bits);
  if (pw.length < 8 || bits < 30) return { score: 0, bits, label: 'Too weak' };
  if (bits < MIN_BACKUP_BITS) return { score: 1, bits, label: 'Weak' };
  if (bits < 65) return { score: 2, bits, label: 'Fair' };
  if (bits < 80) return { score: 3, bits, label: 'Good' };
  return { score: 4, bits, label: 'Strong' };
};

export const strongEnoughForBackup = (pw: string) => passwordStrength(pw).bits >= MIN_BACKUP_BITS && pw.length >= 8;
