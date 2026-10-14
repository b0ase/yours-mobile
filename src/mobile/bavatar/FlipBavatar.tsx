import { useMemo, useState, type ReactNode } from 'react';
import { flipBackSvg, flipPayload } from './flipQr';
import { svgDataUri } from '../wallet/cardBackQr';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useAvatar } from '../names/useAvatar';
import { useAccountNames } from '../names/accountNames';
import { AccountAvatar } from '../names/AccountAvatar';

/**
 * A bAvatar that turns over (owner, 14 Oct 2026). Front: the avatar as it is. Back: a plain QR that pays this
 * person (`bitcoin:<address>` or their paymail; public data only, built on the device). Tap to flip, tap again
 * to flip back; reduced motion crossfades (mobile.css .bw-bflip). The back grows to `backSize` so the code is
 * big enough for a phone camera even when the avatar is small. No pay target → just the front, not a button.
 */
export const FlipBavatar = ({
  front,
  address,
  paymail,
  caption,
  size,
  backSize,
  label = 'bAvatar',
}: {
  front: ReactNode;
  address?: string | null;
  paymail?: string | null;
  caption?: string;
  size: number;
  backSize?: number;
  label?: string;
}) => {
  const [flipped, setFlipped] = useState(false);
  const payload = flipPayload(address, paymail);
  const back = useMemo(
    () => (payload ? svgDataUri(flipBackSvg(payload, { size: 512, caption })) : ''),
    [payload, caption],
  );
  if (!back) return <>{front}</>;
  const px = flipped ? Math.max(size, backSize ?? 200) : size;
  return (
    <button
      type="button"
      className={`bw-bflip${flipped ? ' is-flipped' : ''}`}
      style={{ width: px, height: px }}
      onClick={() => setFlipped((f) => !f)}
      aria-pressed={flipped}
      aria-label={flipped ? `${label}: showing pay code, tap to turn back` : `${label}: tap to show pay code`}
      data-testid="bavatar-flip"
    >
      <span className="bw-bflip-inner">
        <span className="bw-bflip-face bw-bflip-front">{front}</span>
        <span className="bw-bflip-face bw-bflip-back">
          <img src={back} alt={`Pay code for ${caption || payload}`} draggable={false} />
        </span>
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
      address={address || account?.primaryAddress || account?.addresses?.bsvAddress}
      paymail={names.paymail}
      caption={handle || names.paymail || undefined}
      size={size}
      backSize={backSize}
      label="Your bAvatar"
    />
  );
};
