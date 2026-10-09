/**
 * Top-bar bMail button (replaces the centred b): mailbox icon + badge. Opens bMail in the content area (/m/bmail,
 * owner 9 Oct 2026: between the top bar and the tab bar, not over them); tapping it again goes back. Airdrops live
 * in Requests.
 */
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { OPEN_BMAIL_EVENT } from '../bmail/store';
import { useBMailUnread } from '../bmail/useBMail';
import { Mailbox } from 'lucide-react';
import { useAirdrops } from './useAirdrops';

export const BMAIL_ROUTE = '/m/bmail';
// Several TopNavs can be mounted at once: only the first listener routes an openBMail() event.
let lastOpen = 0;

export const AirdropsNavButton = ({ color, ring }: { color: string; ring: string }) => {
  const { badge: drops } = useAirdrops();
  const mail = useBMailUnread();
  const badge = drops + mail;
  const navigate = useNavigate();
  const onMail = useLocation().pathname.startsWith(BMAIL_ROUTE);
  useEffect(() => {
    const on = () => {
      const now = Date.now();
      if (onMail || now - lastOpen < 500) return;
      lastOpen = now;
      navigate(BMAIL_ROUTE);
    };
    window.addEventListener(OPEN_BMAIL_EVENT, on);
    return () => window.removeEventListener(OPEN_BMAIL_EVENT, on);
  }, [navigate, onMail]);
  return (
    <button
      type="button"
      aria-label={badge > 0 ? `bMail, ${badge} new` : 'bMail'}
      aria-pressed={onMail}
      onClick={() => (onMail ? navigate(-1) : navigate(BMAIL_ROUTE))}
      className="relative w-9 h-9 rounded-full flex items-center justify-center cursor-pointer"
      style={{ border: onMail ? `1px solid ${color}` : ring, background: onMail ? `${color}33` : 'transparent' }}
    >
      <Mailbox size={16} color={color} />
      {badge > 0 && (
        <span
          aria-hidden
          className="absolute -top-1 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold leading-none flex items-center justify-center"
          style={{ background: '#F04438', color: '#fff' }}
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  );
};
