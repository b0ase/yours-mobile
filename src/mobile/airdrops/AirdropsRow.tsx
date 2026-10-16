/** Wallet entry point to the Airdrops inbox, with a badge for new items since it was last opened. */
import { useState } from 'react';
import { BookUser, CalendarDays, Layers } from 'lucide-react';
import { AddressBook } from '../wallet/AddressBook';
import { BCal } from '../wallet/BCal';
import { requestAllCards } from '../wallet/allCardsOpen';
import { BALANCE_CARDS_ENABLED } from '../storeBuild';

// Layout matches the cards above it (HandleOnboarding, SweepPrompt): 92% wide, mt-4, rounded-2xl, no bottom
// margin, so the Tokens / NFTs / Names switch's own mt-6 is the gap below (it was mt-0 mb-3: flush on the card
// above and 36px off the tabs). Owner, 15 Oct 2026: split in two, Addresses on the left (it replaced the small
// notebook icon under the cards) and Airdrops on the right, each half the width; then a small square All cards icon
// between them (moved here from beside Swap, which gets its full width back).
// Owner, 16 Oct 2026: [Addresses] [square] [Airdrops], content-sized and centred as a group (no flex-grow), all
// h-12. Owner, 17 Oct 2026: Airdrops became Calendar (opens bCal, as the All cards sheet does), and the middle
// All cards button is wider. Airdrops are still in bMail › Quarantine. The border colour is a theme variable: an inline hex beat every theme override, so White/Gold never changed it.
const PILL = 'shrink-0 h-12 flex items-center gap-2 rounded-2xl px-4 border cursor-pointer';
const LOOK = {
  background: 'var(--bw-surface)',
  borderColor: 'var(--bw-line, #2b2f36)',
  borderWidth: 1,
  borderStyle: 'solid' as const,
};
const LABEL = 'whitespace-nowrap text-sm font-semibold text-white';

// bWalletX only: the All cards browser lives in the balance carousel, which the store build leaves out, so the
// store build drops this button's code entirely (inlined flag) and the row is just the two pills.
const AllCardsSquareImpl = () => (
  <button
    type="button"
    onClick={() => requestAllCards()}
    aria-label="All cards"
    title="All cards"
    className="shrink-0 h-12 w-24 flex items-center justify-center rounded-2xl border cursor-pointer"
    style={LOOK}
  >
    <Layers size={18} color="var(--bw-accent-hi)" aria-hidden="true" />
  </button>
);
const AllCardsSquare = BALANCE_CARDS_ENABLED ? AllCardsSquareImpl : () => null;

export const AirdropsRow = () => {
  const [book, setBook] = useState(false);
  const [cal, setCal] = useState(false);
  return (
    <div className="w-[92%] mx-auto mt-4 flex justify-center items-center gap-3">
      <button type="button" onClick={() => setBook(true)} className={PILL} style={LOOK}>
        <BookUser size={16} color="var(--bw-accent-hi)" />
        <span className={LABEL}>Addresses</span>
      </button>
      <AllCardsSquare />
      <button type="button" onClick={() => setCal(true)} className={PILL} style={LOOK}>
        <CalendarDays size={16} color="var(--bw-accent-hi)" />
        <span className={LABEL}>Calendar</span>
      </button>
      {book && <AddressBook onClose={() => setBook(false)} />}
      {cal && <BCal onClose={() => setCal(false)} />}
    </div>
  );
};
