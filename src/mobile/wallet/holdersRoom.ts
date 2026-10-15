/**
 * MNEE and PNEEs holders' rooms (bit-sign, 15 Oct 2026): any balance gets in, and anyone inside can
 * start a Space. The rooms are token-gated on the coin's BSV-21 id, so the wallet opens them the
 * same way as any token row's Chat: hand the token key to the Chat tab (chat/nav.ts), which proves
 * the holding and opens (or joins) the room. Store builds have no token rooms: Chat opens the
 * Chat tab only.
 */
import { requestChatRoom } from '../chat/nav';
import { PNEE_TOKEN_ID } from '../notes/pnee';
import { tokenRoomsEnabled } from '../storeBuild';

/** MNEE's production token id (public; @mnee/ts-sdk PROD_TOKEN_ID, the one bit-sign gates on). */
export const MNEE_TOKEN_ID = 'ae59f3b898ec61acbdb6cc7a245fabeded0c094bf046f35206a3aec60ef88127_0';

export type HoldersCoin = 'mnee' | 'pnee';

/** The holders room's token key, or null when the coin has no token id in this build. */
export const holdersRoomKey = (coin: HoldersCoin, pneeId: string = PNEE_TOKEN_ID): string | null => {
  const id = coin === 'mnee' ? MNEE_TOKEN_ID : pneeId;
  return id ? `bsv21:${id}` : null;
};

/** Does this edition open the holders room (not just the Chat tab)? */
export const holdersRoomsEnabled = (): boolean => tokenRoomsEnabled();

/** Open the coin's holders room in the wallet's Chat; `goToChat` switches to the Chat tab. */
export const openHoldersRoom = (coin: HoldersCoin, goToChat: () => void, enabled = holdersRoomsEnabled()): void => {
  const key = enabled ? holdersRoomKey(coin) : null;
  if (key) requestChatRoom(key);
  goToChat();
};
