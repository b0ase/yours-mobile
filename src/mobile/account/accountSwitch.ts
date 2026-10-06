import { useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { getPersonalLink } from '../names/personalToken';
import { identityRowText } from '../names/identityText';

/**
 * Account switching, shared by the account drawer (TopNav), the account strip above it and Settings.
 * Same sequence as upstream TopNav.handleSwitchAccount: close the wallet, switch, reload into the account.
 */
export const useAccountSwitch = (onSame?: () => void) => {
  const { chromeStorageService, wallet, setIsSwitchingAccount } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const current = chromeStorageService.getCurrentAccountObject().account?.addresses.identityAddress;

  const switchAccount = async (identityAddress: string) => {
    if (switchingTo) return;
    if (identityAddress === current) return onSame?.();
    setSwitchingTo(identityAddress);
    setIsSwitchingAccount(true);
    wallet?.close?.();
    try {
      await chromeStorageService.switchAccount(identityAddress);
    } catch (err) {
      console.error('[accounts] account switch failed:', err);
      setIsSwitchingAccount(false);
      setSwitchingTo(null);
      addSnackbar('Failed to switch account. Please try again.', 'error');
      return;
    }
    window.location.reload();
  };
  return { current, switchingTo, switchAccount };
};

/** The $handle for an account row: personal token ticker, else the paymail alias / OpNS name. */
export const accountTag = (id: string, displayName: string, paymail: string, handle: string) => {
  const ticker = getPersonalLink(id)?.ticker;
  return ticker ? `$${ticker.replace(/^\$/, '').toUpperCase()}` : identityRowText(displayName, paymail, handle).tag;
};
