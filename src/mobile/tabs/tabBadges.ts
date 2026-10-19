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

type Room = { ticker: string; unread?: number | null; name?: string | null };

let chat = new Map<string, number>();
/** Rooms known to be DMs (named "$a ↔ $b"), for the Chat segment badges. */
let dms = new Set<string>();
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

const isDm = (r: Room) => /↔/.test(r.name || '');
const key = (ticker: string) => ticker.replace(/^\$/, '').toUpperCase();

/** The full room list from the server: replaces every count. */
export const setChatRooms = (rooms: readonly Room[]) => {
  chat = new Map(rooms.map((r) => [key(r.ticker), Math.max(0, Number(r.unread) || 0)]));
  dms = new Set(rooms.filter(isDm).map((r) => key(r.ticker)));
  emit();
};

/** Part of the list (a chat page's own copy): updates those rooms only. */
export const mergeChatRooms = (rooms: readonly Room[]) => {
  let changed = false;
  const next = new Map(chat);
  for (const r of rooms) {
    if (isDm(r) && !dms.has(key(r.ticker))) {
      dms = new Set(dms).add(key(r.ticker));
      changed = true;
    }
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
  dms = new Set();
  emit();
};

/** Total unread across rooms and DMs, skipping muted rooms. */
export const chatUnread = (muted: (ticker: string) => boolean = () => false): number => {
  let n = 0;
  for (const [t, c] of chat) if (!muted(t)) n += c;
  return n;
};

/** The Chat tab's top filters: unread DMs and unread group / room messages, muted rooms left out. */
export const chatUnreadSplit = (muted: (ticker: string) => boolean = () => false): { dms: number; rooms: number } => {
  const out = { dms: 0, rooms: 0 };
  for (const [t, c] of chat) if (!muted(t)) out[dms.has(t) ? 'dms' : 'rooms'] += c;
  return out;
};

// ── Missed calls (Chat › Calls filter): missed since the Calls filter was last opened ──

const CALLS_SEEN = 'bwallet.calls.seenAt';
type CallLike = { direction: string; status: string; answered_at: string | null; created_at: string; id: string };
const missed = (c: CallLike) =>
  c.direction === 'incoming' && !c.answered_at && c.status !== 'ringing' && c.status !== 'active';

/** Missed calls newer than the cursor, skipping ones hidden on this device. No cursor yet: none (no badge for history). */
export const missedCallsSince = (
  calls: readonly CallLike[],
  seenAt: number | null,
  hidden: ReadonlySet<string> = new Set(),
): number =>
  seenAt === null ? 0 : calls.filter((c) => missed(c) && !hidden.has(c.id) && Date.parse(c.created_at) > seenAt).length;

export const readCallsSeen = (): number | null => readAt(CALLS_SEEN);

/** The Calls filter was opened: everything up to now is seen. */
export const markCallsSeen = (now = Date.now()) => {
  writeAt(CALLS_SEEN, now);
  emit();
};

/** First sight of the call log on this device: start the cursor there (history earns no badge). */
export const initCallsSeen = (now = Date.now()) => {
  if (readCallsSeen() === null) writeAt(CALLS_SEEN, now);
};

const readAt = (k: string): number | null => {
  try {
    const v = Number(localStorage.getItem(k));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
};
const writeAt = (k: string, at: number) => {
  try {
    localStorage.setItem(k, String(at));
  } catch {
    // storage unavailable
  }
};

// The cursor in memory as well as in localStorage. When the write fails (storage full or blocked), reading storage back
// gave the old value, so markFeedViewed saw the cursor "move" on every call and emitted every time; useTabBadges runs it
// on each badge change, so the Feed looped until React gave up (error #185, desktop.bwalletx.com/bchatx-feed, 19 Oct 2026).
let seenMem: number | null = null;
const readSeen = (): number | null => {
  let stored: number | null = null;
  try {
    const v = Number(localStorage.getItem(FEED_SEEN));
    stored = Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    // storage unavailable
  }
  if (seenMem === null) return stored;
  return stored === null ? seenMem : Math.max(stored, seenMem);
};
const writeSeen = (at: number) => {
  seenMem = at;
  try {
    localStorage.setItem(FEED_SEEN, String(at));
  } catch {
    // storage unavailable: the in-memory cursor still holds for this session
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

/** Wallet's count is not unread: "Wallet, 2 rooms to set up". */
export const walletBadgeLabel = (label: string, n: number): string =>
  n > 0 ? `${label}, ${n} room${n === 1 ? '' : 's'} to set up` : label;

/** Tests only. */
export const resetBadgesForTest = () => {
  chat = new Map();
  dms = new Set();
  feedLatest = [];
  seenMem = null;
  version = 0;
};
