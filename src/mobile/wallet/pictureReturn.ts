import { useEffect } from 'react';
import type { OneSatContext } from '@1sat/actions';
import { useServiceContext } from '../../hooks/useServiceContext';
import type { ChromeStorageService } from '../../services/ChromeStorage.service';
import { getPaymail } from '../names/accountName';
import { bareName } from '../names/names';
import { claimPaymail, paymailEnabled } from '../names/paymail';
import { adoptLinkedProfile } from '../names/pictureSource';
import { onSocialChange, takePictureReturn } from '../social/socialLogin';

const f = (u: string, i?: RequestInit) => fetch(u, i);

/** The new picture on the public paymail profile too (signed, no transaction), when the account has a name. */
export async function publishPaymailAvatar(ctx: OneSatContext | undefined, storage: ChromeStorageService, url: string) {
  const account = storage.getCurrentAccountObject().account;
  const pm = getPaymail(account?.addresses?.identityAddress);
  if (!url || !pm || !ctx?.wallet || !paymailEnabled()) return;
  await claimPaymail(f, ctx.wallet, bareName(pm), {
    ordAddress: account?.addresses?.ordAddress,
    name: account?.settings?.socialProfile?.displayName || account?.name,
    avatar: url,
  }).catch(() => undefined);
}

/** Back from X / Google for the card's picture sheet: link the account and use its photo (once). */
export function usePictureReturn(onDone: (msg: string) => void) {
  const { apiContext, chromeStorageService } = useServiceContext();
  const id = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress ?? '';
  useEffect(() => {
    if (!id) return;
    const take = () => {
      const p = takePictureReturn(id);
      if (!p) return;
      void adoptLinkedProfile(chromeStorageService, id, p).then((url) => {
        onDone(
          p.avatar ? `Your ${p.provider === 'x' ? 'X' : 'Google'} picture is on` : 'Linked, but it has no picture',
        );
        void publishPaymailAvatar(apiContext, chromeStorageService, url);
      });
    };
    take();
    return onSocialChange(take);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
}
