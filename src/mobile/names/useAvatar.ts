import { useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { resolveImageUrl } from '../../hooks/useIdentity';
import { bavatarDataUri, getLocalAvatar, onAvatarChange, pickAvatar, resolveAvatarUrl } from './avatar';

/** The current (or given) account's avatar URL; with no picture, its bAvatar ('' = gold b). Re-renders on change. */
export const useAvatar = (identityAddress?: string) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const read = () => {
    const accounts = chromeStorageService.getAllAccounts?.() ?? [];
    const acct =
      accounts.find((a) => a.addresses.identityAddress === identityAddress) ??
      chromeStorageService.getCurrentAccountObject().account;
    const raw = pickAvatar({
      local: getLocalAvatar(identityAddress),
      socialAvatar: acct?.settings?.socialProfile?.avatar,
      accountIcon: acct?.icon,
    });
    // No picture of its own: the account's generated bAvatar (computed locally from its identity key).
    if (!raw) return bavatarDataUri(acct?.pubKeys?.identityPubKey);
    try {
      return apiContext?.services ? resolveImageUrl(raw, apiContext) : resolveAvatarUrl(raw);
    } catch {
      return resolveAvatarUrl(raw);
    }
  };
  const [url, setUrl] = useState(read);
  useEffect(() => {
    setUrl(read());
    return onAvatarChange(() => setUrl(read()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityAddress]);
  return url;
};
