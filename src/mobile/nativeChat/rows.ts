/**
 * What the native iPhone chat draws (ios/App/App/NativeChat): display rows only. PURE, so the mapping is tested
 * directly (rows.test.ts).
 *
 * The TypeScript side stays the source of truth for keys, signing, money, membership and the network: these rows are
 * text to show, nothing else. A sealed (e2ee) body never crosses the bridge, not even as ciphertext: the wallet
 * can't open those (chat/linkify.ts), so the row just says so and the room is marked not to be stored.
 */
import { bDraftInfo } from '../chat/bDraft';
import { assignShades, BUBBLE_BASE_DARK, mixHex, shadeFor, TINT_DARK } from '../chat/bubbleShades';
import { isBusinessAgentMessage, orderCardInfo } from '../chat/businessAgent';
import { commissionCardNo } from '../chat/commissions';
import { isSealedMessage, roomIsEncrypted } from '../chat/linkify';
import { arrange, isMarked, isMuted, isPinned, roomKeyOf, type ListPrefs } from '../chat/listPrefs';
import {
  isBotMessage,
  listTimeLabel,
  normHandle,
  previewText,
  roomActivity,
  roomInitial,
  roomTitle,
  threadItems,
  timeLabel,
  type ChatMessage,
  type ChatRoom,
} from '../chat/messages';
import { withoutBlocked } from '../chat/openRooms';
import { mediaPayload } from '../chat/roomMediaInfo';
import { isPrivateB, isReactionEvent, replyOf } from '../chat/social';

export type NativeRowType = 'day' | 'system' | 'message' | 'card';

export type NativeRow = {
  id: string;
  type: NativeRowType;
  text: string;
  /** `$handle`, on the first bubble of someone else's run. */
  author?: string;
  /** The first letter for their tile. */
  initial?: string;
  nameColor?: string;
  /** Their bubble surface (never black on black). */
  bubble?: string;
  time?: string;
  mine?: boolean;
  first?: boolean;
  status?: 'sent' | 'pending' | 'failed';
  edited?: boolean;
  badge?: 'BOT' | 'AI';
  /** Small line under the text, e.g. "Only you can see this". */
  note?: string;
  quoteAuthor?: string;
  quoteText?: string;
  variant?: 'b';
  /** Failed sends: what a retry names. */
  localId?: string;
};

export const SEALED_TEXT = 'Encrypted message';
export const CARD_HINT = 'Open in full room';

const authorOf = (m: ChatMessage) => (m.author_handle ? `$${normHandle(m.author_handle)}` : undefined);

/** A row the native screen can't draw yet: it says what it is, and tapping it opens the full WebView room. */
const cardLabel = (m: ChatMessage): string | null => {
  if (orderCardInfo(m)) return 'Order';
  if (commissionCardNo(m)) return 'Commission';
  if (bDraftInfo(m)) return 'Draft from $b';
  const media = mediaPayload(m);
  if (media) return media.filename ? `Attachment: ${media.filename}` : 'Attachment';
  return null;
};

export const threadRows = (
  messages: ChatMessage[],
  me: string,
  opts: { blocked?: readonly string[]; hidden?: ReadonlySet<string>; now?: Date } = {},
): NativeRow[] => {
  const kept = withoutBlocked(messages, new Set(opts.blocked ?? [])).filter(
    (m) => !isReactionEvent(m) && !opts.hidden?.has(m.id),
  );
  const shades = assignShades(
    kept.map((m) => m.author_handle).filter((h): h is string => !!h && normHandle(h) !== 'b'),
  );
  const rows: NativeRow[] = [];
  for (const it of threadItems(kept, me, opts.now)) {
    if (it.type === 'day') {
      rows.push({ id: it.key, type: 'day', text: it.label });
      continue;
    }
    const m = it.message;
    const card = cardLabel(m);
    if (card) {
      rows.push({ id: it.key, type: 'card', text: card, time: timeLabel(m.created_at), mine: it.mine });
      continue;
    }
    if (isBotMessage(m)) {
      rows.push({
        id: it.key,
        type: 'message',
        text: m.body ?? '',
        author: String(m.event_payload?.name || 'Help Desk bot'),
        initial: 'B',
        badge: 'BOT',
        first: true,
        time: timeLabel(m.created_at),
        status: 'sent',
      });
      continue;
    }
    if (m.kind === 'event') {
      rows.push({ id: it.key, type: 'system', text: m.body || 'Room update' });
      continue;
    }
    const h = (m.author_handle ?? '').toLowerCase();
    const shade = it.mine ? null : (shades.get(normHandle(h)) ?? shadeFor(h));
    const reply = replyOf(m);
    const sealed = isSealedMessage(m);
    const isB = normHandle(h) === 'b';
    const status = m.failed ? 'failed' : m.pending ? 'pending' : 'sent';
    rows.push({
      id: it.key,
      type: 'message',
      text: sealed ? SEALED_TEXT : (m.body ?? ''),
      author: it.mine ? undefined : authorOf(m),
      initial: it.mine ? undefined : (normHandle(h)[0] ?? '?').toUpperCase(),
      nameColor: shade?.ink,
      bubble: shade ? mixHex(shade.tint, BUBBLE_BASE_DARK, TINT_DARK) : undefined,
      time: timeLabel(m.created_at),
      mine: it.mine,
      first: it.firstOfGroup,
      status,
      edited: m.edited || undefined,
      badge: isBusinessAgentMessage(m) ? 'AI' : undefined,
      note: isPrivateB(m) ? 'Only you can see this' : undefined,
      quoteAuthor: reply ? (reply.author ? `$${reply.author}` : '') : undefined,
      quoteText: reply?.snippet,
      variant: isB && !it.mine ? 'b' : undefined,
      localId: status === 'failed' ? m.localId : undefined,
    });
  }
  return rows;
};

/** Sealed rooms stay off the native disk cache entirely; the bridge says so room by room. */
export const roomCacheable = (room: Pick<ChatRoom, 'metadata'>, messages: ChatMessage[]): boolean =>
  !roomIsEncrypted(room, messages);

export type NativeRoomRow = {
  ticker: string;
  key: string;
  title: string;
  preview: string;
  time: string;
  unread: number;
  muted: boolean;
  pinned: boolean;
  marked: boolean;
  initial: string;
  members: number;
  direct: boolean;
};

export const roomRows = (
  rooms: readonly ChatRoom[],
  me: string,
  prefs: ListPrefs,
  opts: { now?: Date } = {},
): NativeRoomRow[] =>
  arrange(rooms, prefs, (r) => roomKeyOf(r.ticker), roomActivity).main.map((r) => {
    const key = roomKeyOf(r.ticker);
    const title = roomTitle(r, me);
    return {
      ticker: r.ticker,
      key,
      title,
      preview: isSealedMessage(r.last_message as Pick<ChatMessage, 'body' | 'event_payload'> | null)
        ? SEALED_TEXT
        : previewText(r, me),
      time: listTimeLabel(r.last_message?.created_at ?? r.updated_at, opts.now),
      unread: r.unread ?? 0,
      muted: isMuted(prefs, key),
      pinned: isPinned(prefs, key),
      marked: isMarked(prefs, key),
      initial: roomInitial(title),
      members: r.party_count ?? 0,
      direct: /↔/.test(r.name || ''),
    };
  });

export type RowsPatch = { from: number; rows: NativeRow[] };

/**
 * The smallest tail that turns `prev` into `next`: everything before `from` is unchanged. Polls and sends usually touch
 * only the last rows, so a 5,000-row room doesn't re-cross the bridge whole. `from` 0 = the whole list. Null: no change.
 */
export const diffRows = (prev: readonly NativeRow[], next: readonly NativeRow[]): RowsPatch | null => {
  const same = (a: NativeRow, b: NativeRow) => JSON.stringify(a) === JSON.stringify(b);
  let i = 0;
  while (i < prev.length && i < next.length && same(prev[i], next[i])) i += 1;
  if (i === prev.length && i === next.length) return null;
  return { from: i, rows: next.slice(i) };
};
