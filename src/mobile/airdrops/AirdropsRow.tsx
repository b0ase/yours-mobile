/** Wallet entry point to the Airdrops inbox, with a badge for new items since it was last opened. */
import { lazy, Suspense, useState } from 'react';
import { ChevronRight, Gift } from 'lucide-react';
import { useAirdrops } from './useAirdrops';

const Inbox = lazy(() => import('./AirdropsInbox').then((m) => ({ default: m.AirdropsInbox })));

export const AirdropsRow = () => {
  const { badge, visible } = useAirdrops();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-[92%] mb-3 flex items-center gap-3 rounded-xl px-4 py-3 border text-left"
        style={{ background: '#17191E', borderColor: '#2b2f36' }}
      >
        <Gift size={16} color="#FFD24D" />
        <span className="flex-1 text-sm font-semibold text-white">Airdrops</span>
        {badge > 0 ? (
          <span
            aria-label={`${badge} new`}
            className="min-w-[20px] h-5 px-1.5 rounded-full text-[11px] font-bold flex items-center justify-center"
            style={{ background: '#F04438', color: '#fff' }}
          >
            {badge > 99 ? '99+' : badge}
          </span>
        ) : (
          visible.length > 0 && <span className="text-xs text-[#98A2B3]">{visible.length}</span>
        )}
        <ChevronRight size={16} color="#98A2B3" />
      </button>
      {open && (
        <Suspense fallback={null}>
          <Inbox onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
};
