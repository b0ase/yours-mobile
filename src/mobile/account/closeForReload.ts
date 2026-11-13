/**
 * Close the wallet before an account switch reloads the page (owner's iPhone, 13 Nov 2026: switching accounts while
 * the first one was still opening left a permanent black screen until a force-quit).
 *
 * On the phone, the web app and Desktop the background (and its IndexedDB stores) runs inside the page, so the reload
 * tore it down mid-sync. Now the page asks it to close first and waits, capped, so a stuck close never blocks the
 * switch. In the Chrome extension the service worker outlives the page and SWITCH_ACCOUNT reopens it there, so only
 * the page's own legacy wallet (if any) is closed.
 */

import { settleWithin, type Settled } from '../../utils/settleWithin';

export { settleWithin };

/** Longest the switch waits for the wallet to close before reloading anyway. */
// 10 s (was 3 s): a close cut short by the cap reloaded into a frozen page (owner's iPhone, 13 Nov 2026, boot trace:
// cap hit → black screen; the close that finished in ~1 s reloaded fine). A slower switch beats a black screen.
export const CLOSE_FOR_RELOAD_CAP_MS = 10_000;

/** The background action that closes the in-page wallet and keeps it closed until the reload. */
export const CLOSE_FOR_RELOAD_ACTION = 'WALLET_CLOSE_FOR_RELOAD';

export interface CloseForReloadDeps {
  /** The page's legacy wallet close (ServiceContext.wallet; not wired in current builds). */
  legacyClose?: () => unknown;
  /** Asks the in-page background to close its wallet (omitted in the extension). */
  closeBackground?: () => unknown;
  capMs?: number;
}

/** Closes both, in parallel, and resolves within the cap however either ends. */
export const closeWalletForReload = async ({
  legacyClose,
  closeBackground,
  capMs = CLOSE_FOR_RELOAD_CAP_MS,
}: CloseForReloadDeps): Promise<{ legacy: Settled | 'skipped'; background: Settled | 'skipped' }> => {
  const [legacy, background] = await Promise.all([
    legacyClose ? settleWithin(legacyClose, capMs) : Promise.resolve('skipped' as const),
    closeBackground ? settleWithin(closeBackground, capMs) : Promise.resolve('skipped' as const),
  ]);
  if (legacy === 'timeout' || background === 'timeout' || background === 'failed')
    console.warn('[accounts] wallet close before reload:', { legacy, background });
  return { legacy, background };
};

/**
 * One account switch at a time across every switcher on screen (drawer, strip, Settings, a bApp's request): each has
 * its own React state, so a second tap elsewhere could start a second switch while the first was closing.
 */
let switching = false;
export const claimAccountSwitch = (): boolean => {
  if (switching) return false;
  switching = true;
  return true;
};
export const releaseAccountSwitch = () => {
  switching = false;
};
