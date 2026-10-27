/**
 * b's welcome card in a new room, ported from bChatX (bit-sign src/components/room/WelcomeCard.tsx, PR #465; owner,
 * 26 Oct 2026: b introduces itself as the platform's agent with a few easy buttons, not a presumptive paragraph).
 * "Just chat" hides it for this viewer and room, remembered on this device; nothing is deleted. Pure helpers.
 */
const KEY = (ticker: string) => `bwallet.roomWelcome.${ticker.toLowerCase()}`;

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const store = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export const welcomeDismissed = (ticker: string, s: Store | null = store()): boolean => {
  try {
    return s?.getItem(KEY(ticker)) === '1';
  } catch {
    return false;
  }
};

export const dismissWelcome = (ticker: string, s: Store | null = store()) => {
  try {
    s?.setItem(KEY(ticker), '1');
  } catch {
    /* private window: the card may show again in an empty room, which is harmless */
  }
};

/** Show it in an empty room that isn't a 1:1, the Lounge or an official room, until "Just chat". */
export const shouldShowWelcome = (
  o: { ticker: string; empty: boolean; dm: boolean; special: boolean },
  s: Store | null = store(),
): boolean => o.empty && !o.dm && !o.special && !welcomeDismissed(o.ticker, s);

/** What "Make an agreement" puts in the composer: b drafts it in the room (bDraft); nothing is signed or sent. */
export const AGREEMENT_DRAFT = '/b draft an agreement for this room: ';
