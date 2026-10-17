import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flipBackSvg, flipPayload } from './flipQr';
import { svgDataUri } from '../wallet/cardBackQr';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useAvatar } from '../names/useAvatar';
import { useAccountNames } from '../names/accountNames';
import { AccountAvatar } from '../names/AccountAvatar';

/**
 * A bAvatar that turns over (owner, 14 Oct 2026). Front: the avatar as it is. Back: the bAvatar Art QR (as on
 * bwalletx.com/bavatars) on a rounded card, paying this person (`bitcoin:<address>` or their paymail; public data
 * only, built on the device). Tap to turn it over, tap again to turn back: a 2D turn in a fixed frame, the face
 * swapping when it is edge-on (mobile.css .bw-bflip; owner 17 Oct 2026: the old 3D flip grew and swung out of
 * frame). The back is `backSize` when given, so the code is big enough for a phone camera.
 * No pay target → just the front, not a button.
 */
export const FlipBavatar = ({
  front,
  artSeed,
  address,
  paymail,
  caption,
  size,
  backSize,
  label = 'bAvatar',
}: {
  front: ReactNode;
  /** Seeds the back's art: the identity key, else a handle or address (same art as their bAvatar). */
  artSeed: string;
  address?: string | null;
  paymail?: string | null;
  caption?: string;
  size: number;
  backSize?: number;
  label?: string;
}) => {
  const [flipped, setFlipped] = useState(false);
  const [turning, setTurning] = useState(false);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const payload = flipPayload(address, paymail);
  const back = useMemo(
    () => (payload ? svgDataUri(flipBackSvg(artSeed, payload, { size: 512 })) : ''),
    [artSeed, payload],
  );
  if (!back) return <>{front}</>;
  // The size changes only at the midpoint, edge-on, so the turn itself never grows or swings.
  const px = flipped ? Math.max(size, backSize ?? size) : size;
  const turn = () => {
    if (turning) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return setFlipped((f) => !f);
    setTurning(true);
    timers.current.push(
      window.setTimeout(() => setFlipped((f) => !f), 220),
      window.setTimeout(() => setTurning(false), 440),
    );
  };
  return (
    <button
      type="button"
      className={`bw-bflip${turning ? ' is-turning' : ''}`}
      style={{ width: px, height: px }}
      onClick={turn}
      aria-pressed={flipped}
      aria-label={flipped ? `${label}: showing pay code, tap to turn back` : `${label}: tap to show pay code`}
      data-testid="bavatar-flip"
    >
      <span className="bw-bflip-face bw-bflip-front" aria-hidden={flipped}>
        {front}
      </span>
      <span className="bw-bflip-face bw-bflip-back" aria-hidden={!flipped}>
        <img src={back} alt={`Pay code for ${caption || payload}`} draggable={false} />
        {caption && <span className="bw-bflip-caption">{caption}</span>}
      </span>
    </button>
  );
};

/** This account's own flip bAvatar: its picture/bAvatar on the front, its receive address on the back. */
export const MyFlipBavatar = ({
  address,
  size,
  backSize,
}: {
  /** The receive address on screen (Receive uses its selected address); defaults to the account's. */
  address?: string | null;
  size: number;
  backSize?: number;
}) => {
  const { chromeStorageService } = useServiceContext();
  const { account } = chromeStorageService.getCurrentAccountObject();
  const id = account?.addresses?.identityAddress;
  const avatar = useAvatar(id);
  const names = useAccountNames(id, account?.name ?? '', account?.settings?.socialProfile?.displayName ?? '', false);
  const handle = names.handle ? `$${String(names.handle).replace(/^\$/, '')}` : '';
  return (
    <FlipBavatar
      front={<AccountAvatar src={avatar} size={size} id={id} />}
      artSeed={account?.pubKeys?.identityPubKey || handle || id || ''}
      address={address || account?.primaryAddress || account?.addresses?.bsvAddress}
      paymail={names.paymail}
      caption={handle || names.paymail || undefined}
      size={size}
      backSize={backSize}
      label="Your bAvatar"
    />
  );
};
