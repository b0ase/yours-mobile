/**
 * Start the app's screens again without reloading the page (index.tsx registers how).
 *
 * On web and Desktop the unlock key is held in memory only (mobile/hub.ts), so a page reload locks the wallet. The
 * end of Create / Restore used to reload into the wallet, which put the lock screen in front of someone who had
 * typed their password seconds before (pages/onboarding/enterWallet.ts). Every React provider and screen is built
 * anew, as after a reload; the page's hub, background worker and in-memory session carry on.
 */
let remount: (() => void) | undefined;

export const setAppRemount = (fn: (() => void) | undefined) => {
  remount = fn;
};

export const getAppRemount = () => remount;
