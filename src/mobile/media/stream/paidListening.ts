import type { WalletInterface } from '@bsv/sdk';
import type { KeySourceKind } from './keySource';
import { openSession } from './session';

/**
 * Paid per-second listening is paused (owner decision, 2 Nov 2026: "hotfix desktop player"). bmusicx.com answers
 * 503 {error:'paused'} for GET /api/bmusic/stream/payto and POST /api/bmusic/stream, so a paid session would fund a
 * session key and then fail on its first second. While this is true, every path that would open the listening budget
 * sheet (a pay-to-play track, a tap on a paid track, "continue" after the sponsor's pot runs out, a top-up when the
 * budget is used up) shows PAID_LISTENING_PAUSED_NOTE instead, and no session is funded. Sponsored playback (tracks
 * 1–6, the sponsor's pot pays) is unchanged. Turn it back off when the new pay-as-you-listen model ships.
 */
export const PAID_LISTENING_PAUSED: boolean = true;

export const PAID_LISTENING_PAUSED_NOTE =
  'Paid listening is paused while we move to the new pay-as-you-listen model. Tracks 1–6 play free.';

/** A request for the listening budget sheet: which track, from which segment, and whether it is a top-up. */
export type BudgetRequest = { track: number; from?: number; topUp?: boolean };

/**
 * The one gate for the budget sheet. Paused: show the note and never open the sheet (so nothing can reach Allow and
 * fund a session). Otherwise: open the sheet as before.
 */
export const routeBudgetRequest = (
  req: BudgetRequest,
  on: { showPaused: () => void; openSheet: (req: BudgetRequest) => void },
  paused: boolean = PAID_LISTENING_PAUSED,
): void => (paused ? on.showPaused() : on.openSheet(req));

/** What a tap on a track does when it needs a new session: sponsored plays free; a paid track asks for a budget. */
export const newSessionAction = (
  kind: KeySourceKind,
  paused: boolean = PAID_LISTENING_PAUSED,
): 'sponsored' | 'paused' | 'budget' => (kind === 'sponsored' ? 'sponsored' : paused ? 'paused' : 'budget');

export class PaidListeningPaused extends Error {
  constructor() {
    super(PAID_LISTENING_PAUSED_NOTE);
    this.name = 'PaidListeningPaused';
  }
}

type FundingWallet = Pick<WalletInterface, 'createHmac' | 'getPublicKey' | 'createAction' | 'internalizeAction'>;

/**
 * Fund a paid session (the budget sheet's Allow). Paused: throws before the wallet is asked for anything, so no
 * createAction runs and no session key is funded.
 */
export const fundPaidSession = (
  wallet: FundingWallet,
  budget: number,
  paused: boolean = PAID_LISTENING_PAUSED,
  open: typeof openSession = openSession,
): ReturnType<typeof openSession> => {
  if (paused) return Promise.reject(new PaidListeningPaused());
  return open(wallet, budget);
};
