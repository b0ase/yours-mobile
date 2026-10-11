/**
 * "Set up your room" (owner, 11 Oct 2026): the first time an issuer opens their own token room, one sheet offers
 * the cover, who can enter, what chatting costs, and listing tickets for sale, with "Set up later". The choice is
 * remembered per room on this device, so the sheet never nags; it stays reachable from the room's ⚙.
 */
export type RoomSetupState = 'done' | 'later' | 'not-issuer';

const KEY = (ticker: string) => `bwallet.roomSetup.${ticker.toLowerCase()}`;

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const store = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export const roomSetupState = (ticker: string, s: Store | null = store()): RoomSetupState | null => {
  try {
    const v = s?.getItem(KEY(ticker));
    return v === 'done' || v === 'later' || v === 'not-issuer' ? v : null;
  } catch {
    return null;
  }
};

export const rememberRoomSetup = (ticker: string, state: RoomSetupState, s: Store | null = store()) => {
  try {
    s?.setItem(KEY(ticker), state);
  } catch {
    /* private window: the sheet may show again, which is harmless */
  }
};

/** Offer the set-up sheet when opening this room? Only for token rooms not yet set up, deferred or ruled out. */
export const shouldOfferRoomSetup = (ticker: string, isTokenRoom: boolean, s: Store | null = store()) =>
  isTokenRoom && roomSetupState(ticker, s) === null;
