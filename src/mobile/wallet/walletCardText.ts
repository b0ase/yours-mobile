/** Pure text helpers for WalletCard. */

/** "12,345 sats" (always shown under the dollar amount, never first). */
export const cardSats = (sats: number): string => `${Math.max(0, Math.round(sats)).toLocaleString('en-US')} sats`;

/** "MM/YY" from a stored creation time (ms); '' when none is stored, so the line is omitted. */
export const memberSince = (createdAt?: number): string => {
  if (!createdAt || !Number.isFinite(createdAt) || createdAt <= 0) return '';
  const d = new Date(createdAt);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getFullYear() % 100).padStart(2, '0')}`;
};

/** "1AbcD…wXyZ" for addresses / key fingerprints. */
export const shortAddr = (a: string): string => (a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-6)}` : a);

/**
 * The unit label on the main wallet card. Back to the standard "BSV" (owner, 3 Nov 2026: "change it back to the
 * standard BSV (no $BSV either please)"); the 25 Oct "$bsv" card-only label is retired. Same as every other screen.
 */
export const MAIN_CARD_UNIT = 'BSV';

/** "BSV 0.01234567" from sats (8 dp, trailing zeros kept to 2). The main wallet card passes MAIN_CARD_UNIT. */
export const cardBsv = (sats: number, label = 'BSV'): string => {
  const v = (Math.max(0, Math.round(sats)) / 1e8).toFixed(8).replace(/(\.\d{2}\d*?)0+$/, '$1');
  return `${label} ${v}`;
};

const UNIT_KEY = 'bw-card-unit';
export type CardUnit = 'usd' | 'bsv';
export const loadCardUnit = (): CardUnit => {
  try {
    return localStorage.getItem(UNIT_KEY) === 'bsv' ? 'bsv' : 'usd';
  } catch {
    return 'usd';
  }
};
export const saveCardUnit = (u: CardUnit) => {
  try {
    localStorage.setItem(UNIT_KEY, u);
  } catch {
    /* private mode */
  }
};
