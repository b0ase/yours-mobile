/** Wallet entry point to the Airdrops inbox, with a badge for new items since it was last opened. */
import { lazy, Suspense, useState } from 'react';
import { ChevronRight, Gift } from 'lucide-react';
import { useAirdrops } from './useAirdrops';

const Inbox = lazy(() => import('./AirdropsInbox').then((m) => ({ default: m.AirdropsInbox })));

// Layout matches the cards above it (HandleOnboarding, SweepPrompt): 92% wide, mt-4, rounded-2xl, no bottom
// margin, so the Tokens / NFTs / Friends switch's own mt-6 is the gap below (it was mt-0 mb-3: flush on the card
// above and 36px off the tabs).
export const AirdropsRow = () => {
  const { badge, visible } = useAirdrops();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-[92%] mx-auto mt-4 flex items-center gap-3 rounded-2xl px-4 py-3 border text-left cursor-pointer"
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
