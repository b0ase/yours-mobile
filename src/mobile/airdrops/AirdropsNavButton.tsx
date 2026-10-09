/** Top-bar bMail button (replaces the centred b): mailbox icon + badge; opens bMail (airdrops live in Requests). */
import { lazy, Suspense, useEffect, useState } from 'react';
import { OPEN_BMAIL_EVENT } from '../bmail/store';
import { useBMailUnread } from '../bmail/useBMail';
import { Mailbox } from 'lucide-react';
import { useAirdrops } from './useAirdrops';

const Inbox = lazy(() => import('../bmail/BMailScreen').then((m) => ({ default: m.BMailScreen })));

export const AirdropsNavButton = ({ color, ring }: { color: string; ring: string }) => {
  const { badge: drops } = useAirdrops();
  const mail = useBMailUnread();
  const badge = drops + mail;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener(OPEN_BMAIL_EVENT, on);
    return () => window.removeEventListener(OPEN_BMAIL_EVENT, on);
  }, []);
  return (
    <>
      <button
        type="button"
        aria-label={badge > 0 ? `bMail, ${badge} new` : 'bMail'}
        onClick={() => setOpen(true)}
        className="relative w-9 h-9 rounded-full flex items-center justify-center bg-transparent cursor-pointer"
        style={{ border: ring }}
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
      {open && (
        <Suspense fallback={null}>
          <Inbox onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
};
