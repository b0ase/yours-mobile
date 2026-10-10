import { createPortal } from 'react-dom';
import { Lock } from 'lucide-react';
import { useBackClose } from '../backStack';
import { BACK_PNEE_DONE_HINT, backPneeDoneTitle } from './backPnee';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';

/**
 * Back PNEEs, last sheet (owner, 10 Oct 2026): after the lock confirms, say where the locked BSV lives and send
 * the user back to the Wallet. Pots & Locks opens only if they choose it.
 */
export const BackPneeDoneSheet = ({
  bsv,
  onWallet,
  onPots,
}: {
  bsv: number;
  onWallet: () => void;
  onPots: () => void;
}) => {
  useBackClose(true, onWallet);
  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-end" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onWallet}>
      <div
        className="w-full rounded-t-2xl p-4 flex flex-col gap-3"
        style={{ background: '#101114', paddingBottom: 'max(env(safe-area-inset-bottom), 16px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <Lock size={20} color={GOLD} />
          <span className="flex-1 text-base font-bold text-white">{backPneeDoneTitle(bsv)}</span>
        </div>
        <p className="text-sm m-0" style={{ color: MUTED }}>
          {BACK_PNEE_DONE_HINT}
        </p>
        <button
          type="button"
          onClick={onWallet}
          className="rounded-xl py-3 text-sm font-bold border-0 cursor-pointer"
          style={{ background: 'linear-gradient(135deg, #de973f, #f9dd63)', color: '#1a1300' }}
        >
          Back to Wallet
        </button>
        <button
          type="button"
          onClick={onPots}
          className="rounded-xl py-3 text-sm font-bold border cursor-pointer bg-transparent"
          style={{ borderColor: '#F5B80055', color: GOLD }}
        >
          Open Pots &amp; Locks
        </button>
      </div>
    </div>,
    document.body,
  );
};
