/**
 * Unread counts for the bottom tabs (phone dock, classic tab bar, wide sidebar). Real data only:
 * - Chat: the server's per-room unread counts (rooms and DMs share one list), muted rooms left out.
 *   The notify engine (notify/engine.ts) refreshes them every poll and on live room events; the chat
 *   lists push their own copy so a room opened or marked read clears at once.
 * - Feed: posts newer than the newest post the user has seen on the Feed (a per-device cursor).
 * - bMail: airdrops + new mail, from useAirdrops / useBMailUnread (see useTabBadges.ts).
 * - Wallet: no badge. New tokens arrive as bMail items, so they count on bMail.
 */
import { tabBadgeText } from '../../components/tabBadgeText';

const FEED_SEEN = 'bwallet.feed.seenAt';

type Room = { ticker: string; unread?: number | null };

let chat = new Map<string, number>();
let feedLatest: number[] = [];
let version = 0;
const listeners = new Set<() => void>();
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};

export const subscribeBadges = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const badgesVersion = () => version;

const key = (ticker: string) => ticker.replace(/^\$/, '').toUpperCase();

/** The full room list from the server: replaces every count. */
export const setChatRooms = (rooms: readonly Room[]) => {
  chat = new Map(rooms.map((r) => [key(r.ticker), Math.max(0, Number(r.unread) || 0)]));
  emit();
};

/** Part of the list (a chat page's own copy): updates those rooms only. */
export const mergeChatRooms = (rooms: readonly Room[]) => {
  let changed = false;
  const next = new Map(chat);
  for (const r of rooms) {
    const n = Math.max(0, Number(r.unread) || 0);
    if (next.get(key(r.ticker)) !== n) {
      next.set(key(r.ticker), n);
      changed = true;
    }
  }
  if (!changed) return;
  chat = next;
  emit();
};

export const clearChatBadges = () => {
  if (!chat.size) return;
  chat = new Map();
  emit();
};

/** Total unread across rooms and DMs, skipping muted rooms. */
export const chatUnread = (muted: (ticker: string) => boolean = () => false): number => {
  let n = 0;
  for (const [t, c] of chat) if (!muted(t)) n += c;
  return n;
};

const readSeen = (): number | null => {
  try {
    const v = Number(localStorage.getItem(FEED_SEEN));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
};
const writeSeen = (at: number) => {
  try {
    localStorage.setItem(FEED_SEEN, String(at));
  } catch {
    // storage unavailable
  }
};

/** Posts strictly newer than the cursor. */
export const countNewSince = (ats: readonly number[], seenAt: number): number =>
  ats.reduce((n, at) => n + (at > seenAt ? 1 : 0), 0);

/** Latest post times from a background fetch. The first time ever, they become the cursor (no badge for history). */
export const setFeedLatest = (ats: readonly number[]) => {
  const good = ats.filter((a) => Number.isFinite(a) && a > 0);
  if (readSeen() === null && good.length) writeSeen(Math.max(...good));
  feedLatest = good;
  emit();
};

/** The Feed was viewed with these posts on screen: the newest becomes the cursor. */
export const markFeedViewed = (ats: readonly number[] = []) => {
  const was = readSeen();
  const newest = Math.max(was ?? 0, ...ats.filter((a) => Number.isFinite(a)), ...feedLatest);
  const next = newest > 0 ? newest : Date.now();
  if (next === was) return;
  writeSeen(next);
  emit();
};

export const feedNew = (): number => {
  const seen = readSeen();
  return seen === null ? 0 : countNewSince(feedLatest, seen);
};

/** Badge text: '' for none, the count, or 99+. */
export const badgeText = tabBadgeText;

/** Accessible label, e.g. "Chat, 3 unread". */
export const badgeLabel = (label: string, n: number): string => (n > 0 ? `${label}, ${badgeText(n)} unread` : label);

/** Tests only. */
export const resetBadgesForTest = () => {
  chat = new Map();
  feedLatest = [];
  version = 0;
};
