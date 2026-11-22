import { getAppRemount } from '../../appRemount';
import { getPlatform } from '../../platform';
import { sendMessageAsync } from '../../utils/chromeHelpers';
import { YoursEventName } from '../../inject';

export type EnterWalletDeps = {
  /** The wallet's first account (Create / Restore / Import from the welcome screen), not an added account. */
  firstWallet: boolean;
  /** Whether the unlock key (chrome.storage.session) is still there after a page reload. */
  sessionSurvivesReload: boolean;
  /** Builds the app's screens anew without a page reload (appRemount.ts); absent when the app did not register one. */
  remount?: () => void;
  /** Asks the background to open the selected account (SWITCH_ACCOUNT). */
  openAccount: () => Promise<unknown>;
  reload: () => void;
};

/**
 * "Enter" at the end of Create / Restore / Import wallet.
 *
 * Phones and the extension reload the page: their session (the unlock key) outlives a reload, so the wallet opens
 * unlocked. Web and Desktop keep the session in memory only (mobile/hub.ts, security audit 25 Oct 2026), so the same
 * reload dropped the key and a brand-new wallet opened on "Welcome back / Enter your password to unlock" (found by
 * the mobile smoke test, 16 Nov 2026). There the page is not reloaded: the background, which started before any
 * account existed, is asked to open the selected account, and the screens are built anew.
 *
 * Nothing is stored for this: the key stays where it already was (the hub's memory) and a wallet that is locked has
 * no key there, so it stays locked. An account added to an existing wallet still reloads, as an account switch does:
 * the page holds the previous account's state and only a reload is known to clear all of it.
 */
export const enterWallet = (d: EnterWalletDeps): 'reloaded' | 'remounted' => {
  if (d.sessionSurvivesReload || !d.firstWallet || !d.remount) {
    d.reload();
    return 'reloaded';
  }
  try {
    // Not awaited: a restored wallet's first open can take minutes (finishSwitch.ts), and requests made meanwhile
    // wait on it in the background. Sent before the remount so it is ahead of the new screens' first requests.
    void d.openAccount().catch((e) => console.warn('[enter] the background was slow or failed to open the wallet', e));
  } catch {
    d.reload();
    return 'reloaded';
  }
  d.remount();
  return 'remounted';
};

/** enterWallet wired to this app (platform hooks, the registered remount, the background). */
export const enterWalletNow = (firstWallet: boolean) =>
  enterWallet({
    firstWallet,
    // Unset (the extension, older embedders) means it survives, as chrome.storage.session does.
    sessionSurvivesReload: getPlatform().sessionSurvivesReload !== false,
    remount: getAppRemount(),
    openAccount: () => sendMessageAsync({ action: YoursEventName.SWITCH_ACCOUNT }),
    reload: () => window.location.reload(),
  });
