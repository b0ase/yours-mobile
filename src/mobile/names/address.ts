import { Utils } from '@bsv/sdk';

/**
 * The one check for "is this a BSV address we can pay": base58check decode (checksum verified by
 * @bsv/sdk), version byte 0x00 (mainnet P2PKH), 20-byte hash160. No regex, no length guesses.
 */
export const isMainnetAddress = (raw: string): boolean => {
  const s = cleanRecipient(raw);
  if (s.length < 26 || s.length > 35) return false;
  try {
    const { prefix, data } = Utils.fromBase58Check(s);
    return (
      Array.isArray(prefix) && prefix.length === 1 && prefix[0] === 0x00 && Array.isArray(data) && data.length === 20
    );
  } catch {
    return false;
  }
};

/** Trim and drop invisible characters (zero-width spaces, BOM) that ride along with pastes. */
export const cleanRecipient = (raw: string): string => raw.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim();

/** "0.01", "$0.01", "$5", "£1", "1.5", "1,000" — an amount typed in the recipient box. */
export const looksLikeAmount = (raw: string): boolean =>
  /^[$£€]?\s*(\d[\d,]*(\.\d*)?|\.\d+)$/.test(cleanRecipient(raw));

export const AMOUNT_HINT = 'That looks like an amount — put it in the Amount field';
