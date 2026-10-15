/** Wallet entry point to the Airdrops inbox, with a badge for new items since it was last opened. */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookUser, Gift, Layers } from 'lucide-react';
import { useAirdrops } from './useAirdrops';
import { AddressBook } from '../wallet/AddressBook';
import { requestAllCards } from '../wallet/allCardsOpen';
import { BALANCE_CARDS_ENABLED } from '../storeBuild';

// Layout matches the cards above it (HandleOnboarding, SweepPrompt): 92% wide, mt-4, rounded-2xl, no bottom
// margin, so the Tokens / NFTs / Names switch's own mt-6 is the gap below (it was mt-0 mb-3: flush on the card
// above and 36px off the tabs). Owner, 15 Oct 2026: split in two, Addresses on the left (it replaced the small
// notebook icon under the cards) and Airdrops on the right, each half the width; then a small square All cards icon
// between them (moved here from beside Swap, which gets its full width back).
const HALF = 'flex-1 min-w-0 flex items-center gap-2 rounded-2xl px-3 py-3 border text-left cursor-pointer';
const LOOK = { background: 'var(--bw-surface)', borderColor: '#2b2f36' };
const LABEL = 'flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-sm font-semibold text-white';

// bWalletX only: the All cards browser lives in the balance carousel, which the store build leaves out, so the
// store build drops this button's code entirely (inlined flag) and the row stays two halves.
const AllCardsSquareImpl = () => (
  <button
    type="button"
    onClick={() => requestAllCards()}
    aria-label="All cards"
    title="All cards"
    className="shrink-0 aspect-square self-stretch flex items-center justify-center rounded-2xl border cursor-pointer"
    style={LOOK}
  >
    <Layers size={18} color="var(--bw-accent-hi)" aria-hidden="true" />
  </button>
);
const AllCardsSquare = BALANCE_CARDS_ENABLED ? AllCardsSquareImpl : () => null;

export const AirdropsRow = () => {
  const { badge, visible } = useAirdrops();
  const navigate = useNavigate();
  const [book, setBook] = useState(false);
  return (
    <div className="w-[92%] mx-auto mt-4 flex gap-3">
      <button type="button" onClick={() => setBook(true)} className={HALF} style={LOOK}>
        <BookUser size={16} color="var(--bw-accent-hi)" />
        <span className={LABEL}>Addresses</span>
      </button>
      <AllCardsSquare />
      <button type="button" onClick={() => navigate('/m/bmail?tab=quarantine')} className={HALF} style={LOOK}>
        <Gift size={16} color="var(--bw-accent-hi)" />
        <span className={LABEL}>Airdrops</span>
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
      </button>
      {book && <AddressBook onClose={() => setBook(false)} />}
    </div>
  );
};
