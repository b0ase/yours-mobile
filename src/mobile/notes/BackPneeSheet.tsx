import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useBackClose } from '../backStack';
import { PNEE_ICON } from './pnee';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const CARD = '#17191E';

const Box = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="rounded-xl p-3" style={{ background: CARD }}>
    <div className="text-sm font-bold text-white mb-1">{title}</div>
    <div className="text-xs leading-relaxed" style={{ color: '#D0D5DD' }}>
      {children}
    </div>
  </div>
);

/**
 * Wallet › PNEE › Back PNEE (owner, 5 Oct 2026): what backing Penny Notes means and what backers get, like a
 * MakerDAO vault. Honest: no promised yield. Opening vaults from the app comes after the mainnet pilot.
 */
export const BackPneeSheet = ({ onClose }: { onClose: () => void }) => {
  useBackClose(true, onClose);
  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-end" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div
        className="w-full max-h-[88vh] overflow-y-auto rounded-t-2xl p-4 flex flex-col gap-3"
        style={{ background: '#101114', paddingBottom: 'max(env(safe-area-inset-bottom), 16px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <img src={PNEE_ICON} alt="" className="w-8 h-8" />
          <span className="flex-1 text-base font-bold text-white">Back PNEEs with your BSV</span>
          <button type="button" aria-label="Close" onClick={onClose} className="p-1 border-0 bg-transparent">
            <X size={18} color={MUTED} />
          </button>
        </div>
        <p className="text-sm m-0" style={{ color: '#D0D5DD' }}>
          Every PNEE is a cent backed by BSV that someone locked in a vault. Backers are those people: you lock BSV and create
          new PNEE against it, like a MakerDAO vault creates DAI.
        </p>
        <Box title="How it works">
          Lock BSV in your own vault and mint PNEE up to a tenth of its value (10x collateral: $10 of BSV backs $1 of PNEE).
          The BSV stays yours. To unlock it, hand back the PNEE you minted.
        </Box>
        <Box title="What you get">
          <b>Spendable cents without selling your BSV.</b> Pay with the PNEE you mint, or sell them to people who want digital
          cents. <b>You keep BSV&apos;s upside:</b> if BSV rises, your vault is worth more and can back more PNEE. <b>Sell at a
          premium:</b> when buyers pay a little over a cent on the Exchange, the difference is yours.
        </Box>
        <Box title="What it costs and risks">
          No interest and no yearly fee. If BSV falls so far that your vault drops below 150% (an 85% fall from 10x), anyone can
          repay its PNEE and take your BSV at a 10% discount: you keep what&apos;s left. Penny Notes are new and in a small
          mainnet pilot; back only what you can afford to lose.
        </Box>
        <div className="rounded-xl p-3 text-xs" style={{ background: '#F5B80014', color: GOLD }}>
          Opening a vault from the wallet is coming after the pilot. Today the first vault is run by bCorp; see bwalletx.com/pnee.
        </div>
      </div>
    </div>,
    document.body,
  );
};
