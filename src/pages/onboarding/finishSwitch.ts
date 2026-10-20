import { withTimeout } from '../../mobile/withTimeout';

type Switcher = { switchAccountForReload: (identityAddress: string) => Promise<void> };

/** How long a restore or import waits for the wallet's background to answer before carrying on. */
export const SWITCH_WAIT_MS = 30_000;

/**
 * Select the new account at the end of Restore / Import wallet, without letting the screen wait forever.
 *
 * Both screens finish with an Enter button that reloads the page, and the reload starts the selected account
 * (switchAccountForReload explains why it must not be started twice). Waiting here for the background's reply held
 * "Restoring…" for minutes or for ever, and a reload then got straight in (owner, 20 Oct 2026: the iPhone preview
 * and the Chrome extension). The selection is saved BEFORE any message is sent, so a slow or lost reply is not a
 * failure: carry on. Any other error (e.g. the background reporting one) is still thrown.
 */
export const switchBeforeReload = async (
  service: Switcher,
  identityAddress: string,
  ms: number = SWITCH_WAIT_MS,
): Promise<void> => {
  try {
    await withTimeout(service.switchAccountForReload(identityAddress), ms, 'Starting the wallet');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/timed out after/.test(msg)) throw e;
    console.warn('[restore] the wallet was slow to answer; carrying on, the account is selected', msg);
  }
};
