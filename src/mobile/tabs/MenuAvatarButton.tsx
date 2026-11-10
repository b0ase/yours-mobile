import { accentById } from '../theme/accents';
import { useRef } from 'react';
import { Menu } from 'lucide-react';
import { AccountAvatar } from '../names/AccountAvatar';
import { useAvatar } from '../names/useAvatar';
import { useAccentId } from '../theme/useAccent';

const LONG_PRESS_MS = 500;

/**
 * Top-left of the bar: ☰ and the user's bAvatar, one button (owner, 9 Nov 2026: the avatar alone hid where settings are).
 * Tap = the menu; long-press = the account switcher.
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
      className="h-9 flex items-center gap-1.5 bg-transparent border-0 cursor-pointer p-0 box-border select-none"
      style={{ WebkitTouchCallout: 'none' }}
    >
      <Menu size={20} color="var(--bw-accent)" strokeWidth={2.25} aria-hidden />
      <span
        className="w-9 h-9 rounded-full flex items-center justify-center box-border"
        style={{ border: white ? '1px solid #000' : ring }}
      >
        <AccountAvatar src={src} size={32} ring={false} place="list" />
      </span>
    </button>
  );
};
