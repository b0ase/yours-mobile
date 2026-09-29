/**
 * Optional hooks for embedders such as a mobile shell. The extension sets
 * none, so all of this is inert there.
 *
 * An embedder assigns globalThis.__yoursPlatform before the app loads. It
 * holds only data and callbacks (no components), so same-origin frames such
 * as prompt.html can share the parent's object.
 */

/** A second way to unlock, e.g. Face ID or fingerprint, offered on the lock screen. */
export type QuickUnlock = {
  /** Button label, e.g. "Unlock with Face ID". */
  label: string;
  /** Link to turn it off, e.g. "Stop using Face ID". */
  disableLabel?: string;
  /** Whether it is set up for the current account. */
  isAvailable: () => Promise<boolean>;
  /**
   * Resolves true once the wallet is unlocked the same way a password unlock
   * does it (session passKey stored, WALLET_UNLOCKED sent). False if cancelled
   * or not possible; the password form stays.
   */
  unlock: () => Promise<boolean>;
  disable?: () => Promise<void>;
  /** Prompt as soon as the lock screen appears. */
  autoPrompt?: boolean;
};

export type PlatformHooks = {
  quickUnlock?: QuickUnlock;
  /** Short notice under the welcome screen title. */
  welcomeNotice?: string;
  /** Called when the wallet home screen appears (after create, restore or unlock). */
  onWalletReady?: () => void;
};

export const getPlatform = (): PlatformHooks =>
  (globalThis as { __yoursPlatform?: PlatformHooks }).__yoursPlatform ?? {};
