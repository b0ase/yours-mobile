import { useEffect, useState } from 'react';
import { BWALLET_MARK_ICON } from './personalToken';
import { botColorOf } from '../agents/agentAccounts';
import { BBot } from '../agents/BBot';
import type { AvatarPlace } from './animatedAvatar';
import { useAvatarPlayback } from './useAvatarPlayback';
import { isBavatarSrc, useBavatarShimmer } from './bavatarShimmer';

/** Round avatar; the default (and any broken image) is the gold b. */
export const AccountAvatar = ({
  src,
  size = 24,
  ring = true,
  id,
  place = 'full',
}: {
  src: string;
  size?: number;
  ring?: boolean;
  /** The account's identity address: an agent account shows its bBot instead (agents/BBot). */
  id?: string | null;
  /** Playback (names/animatedAvatar.ts): 'full' animates (own profile, card, headers); 'list' shows a still frame. */
  place?: AvatarPlace;
}) => {
  const [broken, setBroken] = useState(false);
  const play = useAvatarPlayback(src, place);
  const shimmer = useBavatarShimmer();
  useEffect(() => setBroken(false), [src]);
  const bot = botColorOf(id);
  if (bot)
    return (
      <span
        className="rounded-full shrink-0 inline-flex items-center justify-center box-border"
        style={{ width: size, height: size, background: '#0b0b0b', border: ring ? `1.5px solid ${bot}` : undefined }}
      >
        <BBot color={bot} size={Math.round(size * 0.72)} />
      </span>
    );
  const photo = !!src && !broken;
  const img = (
    <img
      {...play.handlers}
      src={photo ? play.src : BWALLET_MARK_ICON}
      onError={() => setBroken(true)}
      alt=""
      width={size}
      height={size}
      className="rounded-full object-cover shrink-0 box-border"
      style={{ width: size, height: size, ...(photo && ring ? { border: '1.5px solid var(--bw-accent)' } : {}) }}
    />
  );
  return shimmer && photo && isBavatarSrc(src) ? <span className="bw-bavatar-shimmer">{img}</span> : img;
};
