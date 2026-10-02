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
