import { createContext } from 'react';

/**
 * False where a copy of the Wallet card is only a picture of it (the All cards / TimeMachine view): the truth lines
 * (BalanceTruthLines) render nothing there and don't ask the wallet, so that slide keeps its height, no second poller
 * runs, and no button sits inside the card's own tap target.
 */
export const TruthLinesOn = createContext(true);
