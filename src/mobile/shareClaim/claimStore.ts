/**
 * Local record of claimed invites (no keys, no names: inviteId, company, tranches, txid). Recovery rebuilds every
 * lock key from the seed + these ids. Per device; a new device relies on the server's claims list (recovery.ts).
 */
export type ClaimRecord = {
  inviteId: string;
  company: string;
  lockPubKey: string;
  claimedAt: string;
  txid?: string;
  tranches?: { tranche: string; tokenId: string; amount: number; outpoint?: string }[];
};

const KEY = 'bwallet.shareClaims.v1';

export const readClaims = (): ClaimRecord[] => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((c): c is ClaimRecord => !!c && typeof c.inviteId === 'string') : [];
  } catch {
    return [];
  }
};

export const saveClaim = (r: ClaimRecord) => {
  try {
    const rest = readClaims().filter((c) => c.inviteId !== r.inviteId);
    localStorage.setItem(KEY, JSON.stringify([...rest, r]));
  } catch {
    /* storage unavailable: the server's claims list still covers recovery */
  }
};
