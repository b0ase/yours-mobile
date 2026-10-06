import { useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { resolveImageUrl } from '../../hooks/useIdentity';
import { BWALLET_MARK_ICON } from './personalToken';
import { ghostColorOf } from '../agents/agentAccounts';
import { PixelGhost } from '../agents/PixelGhost';
import { getLocalAvatar, onAvatarChange, pickAvatar, resolveAvatarUrl } from './avatar';

/** The current (or given) account's avatar URL, '' = default gold b. Re-renders on change. */
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
    if (!raw) return '';
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

/** Round avatar; the default (and any broken image) is the gold b. */
export const AccountAvatar = ({
  src,
  size = 24,
  ring = true,
  id,
}: {
  src: string;
  size?: number;
  ring?: boolean;
  /** The account's identity address: an agent account shows its ghost instead (agents/PixelGhost). */
  id?: string | null;
}) => {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  const ghost = ghostColorOf(id);
  if (ghost)
    return (
      <span
        className="rounded-full shrink-0 inline-flex items-center justify-center box-border"
        style={{ width: size, height: size, background: '#0b0b0b', border: ring ? `1.5px solid ${ghost}` : undefined }}
      >
        <PixelGhost color={ghost} size={Math.round(size * 0.72)} />
      </span>
    );
  const photo = !!src && !broken;
  return (
    <img
      src={photo ? src : BWALLET_MARK_ICON}
      onError={() => setBroken(true)}
      alt=""
      width={size}
      height={size}
      className="rounded-full object-cover shrink-0 box-border"
      style={{ width: size, height: size, ...(photo && ring ? { border: '1.5px solid #F5B800' } : {}) }}
    />
  );
};
