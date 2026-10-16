import { accentById } from '../theme/accents';
import { useRef, useState } from 'react';
import { Menu } from 'lucide-react';
import { AccountAvatar } from '../names/AccountAvatar';
import { useAvatar } from '../names/useAvatar';
import { useAccentId } from '../theme/useAccent';
import { countMenuOpen, showMenuHint } from './menuHint';

const LONG_PRESS_MS = 500;

/**
 * Top-left of the bar (owner-approved, 16 Oct 2026): the user's bAvatar replaces ☰.
 * Tap = the same menu ☰ opened; long-press = the account switcher. A tiny ☰ badge shows until 3 opens.
 * No router hooks here (see outsideRouter.test.ts).
 */
export const MenuAvatarButton = ({
  identityAddress,
  ring,
  onOpen,
  onLongPress,
}: {
  identityAddress?: string;
  ring: string;
  onOpen: () => void;
  onLongPress: () => void;
}) => {
  const src = useAvatar(identityAddress);
  const accentId = useAccentId();
  const white = accentId === 'white' || !!accentById(accentId).paper;
  const [hint, setHint] = useState(showMenuHint);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longFired = useRef(false);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const start = () => {
    longFired.current = false;
    clear();
    timer.current = setTimeout(() => {
      longFired.current = true;
      timer.current = null;
      onLongPress();
    }, LONG_PRESS_MS);
  };
  const click = () => {
    clear();
    if (longFired.current) {
      longFired.current = false;
      return;
    }
    countMenuOpen();
    setHint(showMenuHint());
    onOpen();
  };
  return (
    <button
      type="button"
      aria-label="Menu and account"
      onClick={click}
      onPointerDown={start}
      onPointerUp={clear}
      onPointerLeave={clear}
      onPointerCancel={clear}
      onContextMenu={(e) => e.preventDefault()}
      className="relative w-9 h-9 rounded-full flex items-center justify-center bg-transparent cursor-pointer p-0 box-border select-none"
      style={{ border: white ? '1px solid #000' : ring, WebkitTouchCallout: 'none' }}
    >
      <AccountAvatar src={src} size={32} ring={false} place="list" />
      {hint && (
        <span
          aria-hidden
          className="absolute flex items-center justify-center rounded-full"
          style={{
            right: -2,
            bottom: -2,
            width: 14,
            height: 14,
            background: 'var(--bw-pack-bg, #010101)',
            border: white ? '1px solid #000' : ring,
          }}
        >
          <Menu size={9} color="var(--bw-accent)" strokeWidth={3} />
        </span>
      )}
    </button>
  );
};
