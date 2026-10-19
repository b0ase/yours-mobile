/**
 * True once there is an open wallet to ask: a wallet exists (the current account has keys) and it is unlocked.
 *
 * Before a wallet exists (the welcome / create screens) the app reports "unlocked" but the background has no keys, so
 * any wallet call there fails with "Wallet not available" and logs an error (release check, 19 Oct 2026). App-wide
 * lookups (calls polling, the profile, the bMail badge) wait for this instead of asking.
 */
export type WalletReadySource = {
  getCurrentAccountObject?: () => { account?: { encryptedKeys?: unknown } | null } | undefined;
};

export const walletReady = (chromeStorageService: WalletReadySource | undefined | null, isLocked: boolean): boolean =>
  !isLocked && !!chromeStorageService?.getCurrentAccountObject?.()?.account?.encryptedKeys;
