import { pinnedRank } from './openRooms';

/** The bWallet Help Desk's room ticker (bit-sign lib/default-rooms). Keyed on the ticker, never the name. */
export const LOUNGE_TICKER = 'LOUNGE';
/** What the wallet calls it (renamed from "bWallet Lounge" on bit-sign, 15 Oct 2026). */
export const HELP_DESK_NAME = 'bWallet Help Desk';
export const HELP_DESK_SHORT = 'Help Desk';
export const isLounge = (ticker: string | null | undefined): boolean => pinnedRank(ticker) === 0;

/** What the yellow Help Desk card shows (LoungeCard.tsx). Pure, for tests. */
export function loungeCardInfo(o: { unread: number; listening: number | null; preview: string; member: boolean }): {
  badge: string | null;
  line: string;
  live: string | null;
} {
  const badge = o.unread > 0 ? (o.unread > 99 ? '99+' : String(o.unread)) : null;
  const line = !o.member
    ? 'Everyone’s welcome. Tap to join the chat.'
    : o.preview.trim() || 'Say hello to everyone in bWallet.';
  const live = o.listening === null ? null : `Live · ${o.listening} listening`;
  return { badge, line, live };
}
