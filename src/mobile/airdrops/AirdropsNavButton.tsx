/** Top-bar Airdrops button (replaces the centred b): mailbox icon + unread badge; opens the Airdrops inbox. */
import { lazy, Suspense, useState } from 'react';
import { Mailbox } from 'lucide-react';
import { useAirdrops } from './useAirdrops';

const Inbox = lazy(() => import('./AirdropsInbox').then((m) => ({ default: m.AirdropsInbox })));

export const AirdropsNavButton = ({ color, ring }: { color: string; ring: string }) => {
  const { badge } = useAirdrops();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label={badge > 0 ? `Airdrops, ${badge} new` : 'Airdrops'}
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
