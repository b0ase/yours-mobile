import type { ChromeStorageService } from '../../services/ChromeStorage.service';
import type { ChromeStorageObject } from '../../services/types/chromeStorage.types';
import { getLocalAvatar, isDefaultAvatar, notifyAvatarChange } from './avatar';

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
