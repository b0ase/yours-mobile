import { useServiceContext } from '../../hooks/useServiceContext';
import { useAccountNames } from '../names/accountNames';

/**
 * The current account's display name (BAP profile name, else account name), the same name the
 * top bar shows. Chat shows it first and the bChat $handle second, so one account has one name.
 */
export const useChatDisplayName = () => {
  const { chromeStorageService } = useServiceContext();
  const acct = chromeStorageService.getCurrentAccountObject().account;
  return useAccountNames(
    acct?.addresses.identityAddress,
    acct?.name ?? '',
    acct?.settings?.socialProfile?.displayName ?? '',
    false,
  ).displayName;
};
