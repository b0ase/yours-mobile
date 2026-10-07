import { lazy, Suspense, useState } from 'react';
import { History } from 'lucide-react';

const HistoryScreen = lazy(() => import('./HistoryScreen'));

/**
 * Wallet top row (owner, round 6): price feed · Buy BSV · History. History opens the Activity / History screen
 * (HistoryScreen.tsx). `className` sizes it in the row.
 */
export const HistoryButton = ({ className = '' }: { className?: string }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`flex items-center justify-center gap-1.5 rounded-xl py-3 text-sm font-bold border cursor-pointer ${className}`.trim()}
        style={{ background: '#17191E', borderColor: '#2b2f36', color: '#fff' }}
      >
        <History size={15} aria-hidden="true" />
        History
      </button>
      {open && (
        <Suspense fallback={null}>
          <HistoryScreen onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
};
