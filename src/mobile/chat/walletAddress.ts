/**
 * Telling bChatX which address this wallet receives BSV at, so the owner's bChatX profile can show
 * their real balance (bit-sign POST /api/bitsign/me/wallet-address, lib/bwallet-address.ts).
 * The wallet proves it with a signature by its identity key; keep the message and key ID in step
 * with bit-sign.
 */
export const WALLET_ADDRESS_PROTOCOL: [2, string] = [2, 'bwallet sign in'];
export const WALLET_ADDRESS_KEY_ID = 'wallet-address';

export const walletAddressMessage = (address: string, handle: string): string =>
  `bChatX wallet address ${address} for ${handle.replace(/^\$/, '').toLowerCase()}`;

/** What was last reported for an account, so we post again only when the handle or address changes. */
export const reportedKey = (handle: string, address: string) => `${handle.replace(/^\$/, '').toLowerCase()}|${address}`;
export const REPORTED_STORAGE_PREFIX = 'bwallet.bchat.walletAddress.';

/** After bChatX refuses the report (403: the account has no bWalletX sign-in yet), wait this long before asking again. */
export const REFUSED_RETRY_MS = 24 * 60 * 60 * 1000;
/** Stored value for a refused report: the same key, marked refused, with when. */
export const refusedMark = (key: string, now: number) => `refused|${now}|${key}`;
/** True when `stored` says this exact key was refused less than REFUSED_RETRY_MS ago. */
export const refusedRecently = (stored: string | null, key: string, now: number): boolean => {
  const m = stored?.match(/^refused\|(\d+)\|(.*)$/);
  return !!m && m[2] === key && now - Number(m[1]) < REFUSED_RETRY_MS;
};
