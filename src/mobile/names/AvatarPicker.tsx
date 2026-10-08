import { useRef, useState } from 'react';
import { Camera } from 'lucide-react';
import { SendConfirmation } from '../../components/SendConfirmation';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useTheme } from '../../hooks/useTheme';
import { useIdentity } from '../../hooks/useIdentity';
import type { ChromeStorageObject } from '../../services/types/chromeStorage.types';
import { txFeeSats } from '../mint/mint';
import { AccountAvatar } from './AccountAvatar';
import { useAvatar } from './useAvatar';
import { removeAccountPhoto } from './socialAvatar';
import { dataUrlBytes, getLocalAvatar, paymailAvatar, resizeAvatar, setLocalAvatar } from './avatar';
import { claimPaymail, paymailEnabled } from './paymail';
import { getPaymail } from './accountName';
import { bareName } from './names';
import { moneyNow } from '../money/money';

/** BAP profile update tx (~400 B) on top of the image inscription. */
const PROFILE_TX_SATS = 60;
const f = (u: string, i?: RequestInit) => fetch(u, i);

/**
 * Avatar step (handle flow, optional): pick a photo → resized to ~256 px → stored locally for
 * instant display (and as the account icon). Publishing it (inscribe + BAP profile + paymail
 * profile) is a separate, explicit button behind the standard confirmation sheet.
 */
export const AvatarPicker = ({ displayName }: { displayName: string }) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const { theme } = useTheme();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const id = account?.addresses?.identityAddress ?? '';
  const avatar = useAvatar(id);
  const input = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const identity = useIdentity(apiContext, chromeStorageService);
  const local = getLocalAvatar(id);
  const bytes = local ? dataUrlBytes(local) : 0;
  const cost = bytes ? txFeeSats(bytes, chromeStorageService.getCustomFeeRate()) + PROFILE_TX_SATS : 0;

  const pick = async (file?: File) => {
    if (!file || !id) return;
    try {
      const dataUrl = await resizeAvatar(file);
      setLocalAvatar(id, dataUrl);
      // Also the account icon, so the account list shows it.
      if (account) {
        const key: keyof ChromeStorageObject = 'accounts';
        await chromeStorageService
          .updateNested(key, { [id]: { ...account, icon: dataUrl } } as Partial<ChromeStorageObject['accounts']>)
          .catch(() => undefined);
      }
      setMsg('Saved on this phone. Publish it to show it to others.');
    } catch {
      setMsg("Couldn't read that photo.");
    }
  };

  const publish = async () => {
    setBusy(true);
    setMsg('');
    try {
      const b64 = local.split(',')[1] ?? '';
      const ins = await identity.inscribeAvatar(b64, 'image/jpeg');
      if (!ins.url) throw new Error(ins.error || 'Inscription failed');
      const res = await identity.saveProfile({
        name: identity.profile.name || displayName,
        image: ins.url,
        description: identity.profile.description,
      });
      if (res.error) throw new Error(res.error);
      // Paymail profile (public capability): the ORDFS URL of the inscription. Signed, no tx.
      const pm = getPaymail(id);
      const outpoint = ins.url.slice('1sat://'.length).replace('.', '_');
      const httpsUrl = paymailAvatar(apiContext.services?.ordfs.getContentUrl(outpoint) ?? '');
      if (pm && paymailEnabled() && httpsUrl) {
        await claimPaymail(f, apiContext.wallet, bareName(pm), {
          ordAddress: account?.addresses?.ordAddress,
          name: identity.profile.name || displayName,
          avatar: httpsUrl,
        }).catch(() => undefined);
      }
      setMsg('Published. Your photo is on your public profile.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Publish failed');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-1.5">
      <button
        type="button"
        onClick={() => input.current?.click()}
        aria-label={avatar ? 'Change photo' : 'Add a photo'}
        className="relative bg-transparent border-0 p-0 cursor-pointer"
      >
        <AccountAvatar src={avatar} size={64} />
        <span
          className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full"
          style={{ background: '#FFD24D' }}
        >
          <Camera size={13} color="#000" />
        </span>
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <span className="text-[11px]" style={{ color: '#98A2B3' }}>
        {avatar ? 'Tap to change your photo' : 'Add a photo (optional) or keep the gold b'}
      </span>
      {avatar && (
        <button
          type="button"
          onClick={() =>
            void removeAccountPhoto(chromeStorageService, id).then(() =>
              setMsg(
                identity.isPublished && identity.profile.image
                  ? 'Removed on this phone. A photo published to your public profile stays there until you publish a new one.'
                  : 'Photo removed.',
              ),
            )
          }
          className="text-[11px] bg-transparent border-0 p-0 cursor-pointer underline"
          style={{ color: '#F97066' }}
        >
          Remove photo
        </button>
      )}
      {local && identity.bapId && (
        <button
          type="button"
          disabled={busy}
          onClick={() => setConfirming(true)}
          className="text-[11px] font-semibold bg-transparent border-0 p-0 cursor-pointer underline disabled:opacity-40"
          style={{ color: '#FFD24D' }}
        >
          Publish photo to my public profile (~{moneyNow(cost)})
        </button>
      )}
      {msg && (
        <span className="text-[11px] text-center" style={{ color: '#98A2B3' }}>
          {msg}
        </span>
      )}
      <SendConfirmation
        show={confirming}
        theme={theme}
        lineItems={[
          { address: 'Photo (on-chain)', amount: `${Math.ceil(bytes / 1024)} KB` },
          { address: 'Network fee', amount: `~${moneyNow(cost)}` },
        ]}
        total={`~${moneyNow(cost)}`}
        isProcessing={busy}
        onConfirm={() => void publish()}
        onCancel={() => !busy && setConfirming(false)}
      />
    </div>
  );
};
