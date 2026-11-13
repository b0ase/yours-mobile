import { useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { getPersonalLink } from '../names/personalToken';
import { identityRowText } from '../names/identityText';
import { setChatAccount, setChatReceiveAddress } from '../chat/chatAccount';
import { markAccountUsed } from './accountMenu';
import { IS_EXTENSION } from '../extension';
import { markBootStage } from '../bootWatchdog';
import { SWITCH_LANDED_KEY } from '../phone/pageEl';
import { loseAllGl } from '../ui/liveGl';
import {
  CLOSE_FOR_RELOAD_ACTION,
  claimAccountSwitch,
  closeWalletForReload,
  releaseAccountSwitch,
} from './closeForReload';
import type { LegacyWallet } from '../../contexts/ServiceContext';

/**
 * Closes the wallet (capped, closeForReload.ts) and reloads into the selected account. Outside the extension the
 * background runs in this page, so it is asked to close its stores before the reload tears them down.
 */
export const closeAndReload = async (wallet: LegacyWallet | undefined) => {
  markBootStage('switch: closing wallet');
  await closeWalletForReload({
    legacyClose: wallet?.close ? () => wallet.close?.() : undefined,
    closeBackground: IS_EXTENSION
      ? undefined
      : async () => {
          const r = (await chrome.runtime.sendMessage({ action: CLOSE_FOR_RELOAD_ACTION })) as { data?: unknown } | undefined;
          // Which close steps ran and how long each took, into the boot trace (bootWatchdog.ts).
          markBootStage(`switch: background close ${JSON.stringify(r?.data ?? null).slice(0, 400)}`);
        },
  });
  releaseGraphics();
  try {
    sessionStorage.setItem(SWITCH_LANDED_KEY, '1'); // the reload opens on the Wallet, not Ask b (phone/pageEl.ts)
  } catch {
    /* storage unavailable: it opens on Ask b as before */
  }
  markBootStage('switch: reloading');
  window.location.reload();
};

/** Drop the app's live WebGL contexts (ui/liveGl.ts) before the reload. */
export const releaseGraphics = () => loseAllGl();

/**
 * Account switching, shared by the account drawer (TopNav), the account strip above it and Settings.
 * Same sequence as upstream TopNav.handleSwitchAccount: switch, close the wallet (awaited, capped), reload.
 */
export const useAccountSwitch = (onSame?: () => void) => {
  const { chromeStorageService, wallet, setIsSwitchingAccount, isReady } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const current = chromeStorageService.getCurrentAccountObject().account?.addresses.identityAddress;

  const switchAccount = async (identityAddress: string) => {
    if (switchingTo || !isReady) return;
    if (identityAddress === current) return onSame?.();
    // One switch at a time across all switchers; a second tap while one is closing is ignored.
    if (!claimAccountSwitch()) return;
    setSwitchingTo(identityAddress);
    setIsSwitchingAccount(true);
    try {
      await chromeStorageService.switchAccountForReload(identityAddress);
      // Act as the new account at once (before the reload): no request may reuse the old session.
      setChatAccount(identityAddress);
      setChatReceiveAddress(null); // the new account's address arrives with its storage refresh
      // Recent accounts sort first in the switcher (accountMenu.ts).
      markAccountUsed(identityAddress);
    } catch (err) {
      console.error('[accounts] account switch failed:', err);
      releaseAccountSwitch();
      setIsSwitchingAccount(false);
      setSwitchingTo(null);
      addSnackbar('Failed to switch account. Please try again.', 'error');
      return;
    }
    await closeAndReload(wallet);
  };
  return { current, switchingTo, switchAccount };
};

/** The $handle for an account row: personal token ticker, else the paymail alias / OpNS name. */
export const accountTag = (id: string, displayName: string, paymail: string, handle: string) => {
  const ticker = getPersonalLink(id)?.ticker;
  return ticker ? `$${ticker.replace(/^\$/, '').toUpperCase()}` : identityRowText(displayName, paymail, handle).tag;
};
