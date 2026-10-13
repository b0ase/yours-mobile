/**
 * The Mint's note studio is the owner's only (owner, 13 Oct 2026): banknote designs are fixed and
 * issued only by The Bitcoin Corporation Mint, so users never design or mint their own. Access is an
 * allow-list of identity public keys or identity addresses from VITE_BMINT_STUDIO_KEYS
 * (comma-separated). Empty by default, so nobody sees the studio unless the build sets it.
 */
export const parseStudioKeys = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(/[\s,]+/)
    .map((k) => k.trim())
    .filter(Boolean);

export const BMINT_STUDIO_KEYS: readonly string[] = parseStudioKeys(import.meta.env.VITE_BMINT_STUDIO_KEYS);

/** True when this account's identity key or identity address is on the list. */
export const isStudioOwner = (
  account: { identityPubKey?: string; identityAddress?: string },
  keys: readonly string[] = BMINT_STUDIO_KEYS,
): boolean => keys.length > 0 && [account.identityPubKey, account.identityAddress].some((k) => !!k && keys.includes(k));
