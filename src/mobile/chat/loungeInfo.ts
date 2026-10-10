import { pinnedRank } from './openRooms';

/** The bWallet Lounge's room ticker (bit-sign lib/default-rooms). */
export const LOUNGE_TICKER = 'LOUNGE';
export const isLounge = (ticker: string | null | undefined): boolean => pinnedRank(ticker) === 0;

/** What the yellow Lounge card shows (LoungeCard.tsx). Pure, for tests. */
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
