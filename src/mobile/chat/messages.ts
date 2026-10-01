/**
 * Pure chat logic for the native Chat tab: message merge/ordering, day
 * separators, room titles and previews. No I/O, so it is unit-tested directly.
 */

/** A bChat room message as returned by /api/bitsign/rooms/[ticker]/messages. */
export interface ChatMessage {
  id: string;
  room_id?: string;
  author_handle: string | null;
  kind: 'text' | 'event' | string;
  body: string | null;
  event_type?: string | null;
  event_payload?: Record<string, unknown> | null;
  created_at: string;
  root_id?: string | null;
  supersedes_id?: string | null;
  edited?: boolean;
  /** Client-only: optimistic message not yet acknowledged by the server. */
  pending?: boolean;
  /** Client-only: send failed. */
  failed?: boolean;
  /** Client-only: correlates an optimistic message with the server row that replaces it. */
  localId?: string;
  // ── v2 hooks (not built yet; see docs/NATIVE-CHAT-PLAN.md) ──
  // attachments?: ChatAttachment[];   voice/video notes, files (rooms/[ticker]/media)
  // reactions?: Record<string, string[]>;
  // encrypted?: { scheme: string; ciphertext: string }; token-gated room encryption
}

/** A row of /api/bitsign/rooms (only the fields the native list uses). */
export interface ChatRoom {
  id: string;
  ticker: string;
  name: string | null;
  party_count?: number;
  unread?: number;
  updated_at?: string | null;
  created_at?: string | null;
  access_note?: string | null;
  list_kind?: string | null;
  /** Handle that opened the room (its admin, with owner-role members). */
  created_by_handle?: string | null;
  /** Token rooms carry metadata.tokenGate ({key, symbol, dec, minAmountRaw}). */
  metadata?: Record<string, unknown> | null;
  last_message?: {
    author_handle: string | null;
    kind: string;
    body: string | null;
    event_type: string | null;
    created_at: string;
  } | null;
}

const ts = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/**
 * Merge incoming server messages into the current list: dedupe by id, let an
 * edited version replace the one it supersedes, drop an optimistic copy once
 * its server row arrives (same author + body), and keep oldest-first order.
 */
export const mergeMessages = (current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] => {
  // Edits keep the original's position: order by the chain root's time, which
  // must be read before the superseded original is dropped.
  const rootTime = new Map<string, number>();
  for (const m of [...current, ...incoming]) {
    const root = m.root_id || m.id;
    const t = ts(m.created_at);
    if (!rootTime.has(root) || t < rootTime.get(root)!) rootTime.set(root, t);
  }
  const byId = new Map<string, ChatMessage>();
  for (const m of current) byId.set(m.localId && m.pending ? `local:${m.localId}` : m.id, m);

  for (const m of incoming) {
    if (m.supersedes_id) byId.delete(m.supersedes_id);
    // Resolve a matching optimistic message (oldest pending first) — only the
    // first time this server row is seen, so a re-polled row can't eat a newer
    // identical pending message.
    if (!byId.has(m.id))
      for (const [key, c] of byId) {
        if (c.pending && !c.failed && c.author_handle === m.author_handle && c.body === m.body) {
          byId.delete(key);
          break;
        }
      }
    byId.set(m.id, { ...byId.get(m.id), ...m, pending: false, failed: false });
  }

  return [...byId.values()].sort((a, b) => {
    const at = rootTime.get(a.root_id || a.id) ?? ts(a.created_at);
    const bt = rootTime.get(b.root_id || b.id) ?? ts(b.created_at);
    if (at !== bt) return at - bt;
    // Pending (local) messages sort after acknowledged ones at the same instant.
    if (!!a.pending !== !!b.pending) return a.pending ? 1 : -1;
    return a.id.localeCompare(b.id);
  });
};

/** Newest server timestamp in a list (the `since` cursor for polling). */
export const latestCursor = (messages: ChatMessage[]): string | null => {
  let best: string | null = null;
  for (const m of messages) if (!m.pending && (!best || ts(m.created_at) > ts(best))) best = m.created_at;
  return best;
};

/** Oldest server timestamp (the `before` cursor for loading older). */
export const oldestCursor = (messages: ChatMessage[]): string | null => {
  let best: string | null = null;
  for (const m of messages) if (!m.pending && (!best || ts(m.created_at) < ts(best))) best = m.created_at;
  return best;
};

export const normHandle = (h: string) => h.trim().replace(/^\$/, '').toLowerCase();

/** Local calendar day key, for day separators. */
export const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

export type ThreadItem =
  | { type: 'day'; key: string; label: string }
  | { type: 'msg'; key: string; message: ChatMessage; mine: boolean; firstOfGroup: boolean };

export const dayLabel = (iso: string, now = new Date()) => {
  const d = new Date(iso);
  const today = dayKey(now.toISOString());
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  const k = dayKey(iso);
  if (k === today) return 'Today';
  if (k === dayKey(y.toISOString())) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
};

/** Messages interleaved with day separators; consecutive same-author bubbles are grouped. */
export const threadItems = (messages: ChatMessage[], me: string, now = new Date()): ThreadItem[] => {
  const out: ThreadItem[] = [];
  const mine = normHandle(me);
  let lastDay = '';
  let lastAuthor: string | null | undefined;
  for (const m of messages) {
    const k = dayKey(m.created_at);
    if (k !== lastDay) {
      out.push({ type: 'day', key: `day:${k}`, label: dayLabel(m.created_at, now) });
      lastDay = k;
      lastAuthor = undefined;
    }
    const author = m.kind === 'event' ? null : m.author_handle ? normHandle(m.author_handle) : null;
    out.push({
      type: 'msg',
      key: m.localId && m.pending ? `local:${m.localId}` : m.id,
      message: m,
      mine: !!author && author === mine,
      firstOfGroup: author !== lastAuthor,
    });
    lastAuthor = author;
  }
  return out;
};

export const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** Chat-list timestamp: time today, weekday this week, else short date. */
export const listTimeLabel = (iso: string | null | undefined, now = new Date()) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (dayKey(iso) === dayKey(now.toISOString())) return timeLabel(iso);
  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

/**
 * Display title for a room. A DM is created as "$me ↔ $other", so for the
 * viewer it reads as the other person's handle.
 */
export const roomTitle = (room: Pick<ChatRoom, 'name' | 'ticker'>, me: string) => {
  const name = (room.name || '').trim();
  const dm = name.match(/^\$?([\w.-]+)\s*↔\s*\$?([\w.-]+)$/);
  if (dm) {
    const mine = normHandle(me);
    const [a, b] = [normHandle(dm[1]), normHandle(dm[2])];
    return `$${a === mine ? b : a}`;
  }
  return name || `$${room.ticker}`;
};

export const isDirectRoom = (room: Pick<ChatRoom, 'name'>) => /↔/.test(room.name || '');

export const roomInitial = (title: string) => (title.replace(/^\$/, '').trim()[0] || '?').toUpperCase();

export const previewText = (room: ChatRoom, me: string) => {
  const m = room.last_message;
  if (!m) return room.access_note || 'No messages yet';
  const body = (m.body || '').replace(/\s+/g, ' ').trim() || (m.kind === 'event' ? 'Room update' : 'Attachment');
  if (m.kind !== 'event' && m.author_handle && normHandle(m.author_handle) === normHandle(me)) return `You: ${body}`;
  if (m.kind !== 'event' && m.author_handle && !isDirectRoom(room)) return `$${normHandle(m.author_handle)}: ${body}`;
  return body;
};

export const roomActivity = (room: ChatRoom) =>
  ts(room.last_message?.created_at) || ts(room.updated_at) || ts(room.created_at);

/** Newest activity first. */
export const sortRooms = (rooms: ChatRoom[]) => [...rooms].sort((a, b) => roomActivity(b) - roomActivity(a));

export const filterRooms = (rooms: ChatRoom[], query: string, me: string) => {
  const q = query.trim().toLowerCase().replace(/^\$/, '');
  if (!q) return rooms;
  return rooms.filter(
    (r) =>
      roomTitle(r, me).toLowerCase().includes(q) ||
      r.ticker.toLowerCase().includes(q) ||
      (r.last_message?.body || '').toLowerCase().includes(q),
  );
};

/** Pastel-on-dark avatar colour, stable per seed. */
export const avatarHue = (seed: string) => {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
};
