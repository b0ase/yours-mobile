import type { ChromeStorageService } from '../../services/ChromeStorage.service';
import type { ChromeStorageObject } from '../../services/types/chromeStorage.types';
import { HOSTED_YOURS_IMAGE } from '../../utils/constants';
import { getLocalAvatar, isDefaultAvatar, notifyAvatarChange, setLocalAvatar } from './avatar';

/**
 * Signing in with X or Google makes that photo the account's avatar (owner, 4 Oct 2026), unless the
 * person already picked their own. Stored as the account's socialProfile.avatar (avatar.ts source 3).
 */
export async function adoptSocialAvatar(storage: ChromeStorageService, url: string | null | undefined) {
  const account = storage.getCurrentAccountObject().account;
  if (!url || !account) return;
  const id = account.addresses.identityAddress;
  const current = account.settings?.socialProfile?.avatar;
  if (getLocalAvatar(id) || (current && !isDefaultAvatar(current) && current !== url)) return;
  const key: keyof ChromeStorageObject = 'accounts';
  await storage
    .updateNested(key, {
      [id]: {
        ...account,
        icon: url,
        settings: { ...account.settings, socialProfile: { ...account.settings.socialProfile, avatar: url } },
      },
    } as Partial<ChromeStorageObject['accounts']>)
    .catch(() => undefined);
  notifyAvatarChange();
}

/**
 * Remove photo (owner, 8 Oct 2026): this account goes back to the gold b on this device. Clears only
 * this account's photo (local copy, account icon, social photo); other accounts keep theirs. A photo
 * already published to the public profile stays there until a new one is published.
 */
export async function removeAccountPhoto(storage: ChromeStorageService, identityAddress: string) {
  const account = storage.getAllAccounts?.().find((a) => a.addresses.identityAddress === identityAddress);
  if (!identityAddress) return;
  setLocalAvatar(identityAddress, '');
  if (account) {
    const key: keyof ChromeStorageObject = 'accounts';
    await storage
      .updateNested(key, {
        [identityAddress]: {
          ...account,
          icon: HOSTED_YOURS_IMAGE,
          settings: { ...account.settings, socialProfile: { ...account.settings.socialProfile, avatar: '' } },
        },
      } as Partial<ChromeStorageObject['accounts']>)
      .catch(() => undefined);
  }
  notifyAvatarChange();
}
