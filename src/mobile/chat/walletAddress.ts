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
