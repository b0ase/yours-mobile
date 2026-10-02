/**
 * Open rooms — chatrooms with no token to hold. The pure part (unit-tested in openRooms.test.ts).
 *
 * Anyone signed in to bChat can open one: public (listed, anyone joins) or invite-only (joined
 * with an invite code / link, or added by the owner). The server (bit-sign, /api/bitsign/rooms/open)
 * is the system of record; an open room is an ordinary bChat room whose metadata.kind is 'open',
 * so messages, unread counts and push work exactly as in token rooms.
 *
 * Available in EVERY build, store build included: nothing here is paid or token-gated.
 * Also: the local block list and the report reasons (Chat › message / room menus).
 */
import type { ChatMessage, ChatRoom } from './messages';

export type OpenVisibility = 'public' | 'invite';
export type OpenRole = 'owner' | 'moderator' | 'member' | 'none';

/** A row of GET /api/bitsign/rooms/open. */
export interface PublicRoom {
  ticker: string;
  name: string;
  description: string | null;
  official: boolean;
  memberCount: number;
  joined: boolean;
}

/** GET /api/bitsign/rooms/open/[ticker]. */
export interface OpenRoomCard {
  ticker: string;
  name: string;
  description: string | null;
  visibility: OpenVisibility;
  official: boolean;
  owner: string;
  moderators: string[];
  closed: boolean;
  role: OpenRole;
  members: string[];
  inviteCode: string | null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const norm = (h: string | null | undefined) => (h || '').trim().replace(/^\$/, '').toLowerCase();

export const isOpenRoom = (room: Pick<ChatRoom, 'metadata'> | null | undefined): boolean =>
  (room?.metadata as { kind?: unknown } | null | undefined)?.kind === 'open';

/** The open block of a room's metadata, as the list needs it. */
export const openInfo = (
  room: Pick<ChatRoom, 'metadata'>,
): { description: string | null; visibility: OpenVisibility; official: boolean; closed: boolean } | null => {
  if (!isOpenRoom(room)) return null;
  const o = ((room.metadata as Record<string, unknown>).open ?? {}) as Record<string, unknown>;
  return {
    description: str(o.description) || null,
    visibility: o.visibility === 'invite' ? 'invite' : 'public',
    official: o.official === true,
    closed: typeof o.closed_at === 'string' && !!o.closed_at,
  };
};

export const parsePublicRooms = (data: unknown): PublicRoom[] => {
  const rows = (data as { rooms?: unknown } | null)?.rooms;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r: Record<string, unknown>) => ({
      ticker: str(r.ticker),
      name: str(r.name) || str(r.ticker),
      description: str(r.description) || null,
      official: r.official === true,
      memberCount: Number(r.member_count) || 0,
      joined: r.joined === true,
    }))
    .filter((r) => r.ticker);
};

export const parseRoomCard = (data: unknown): OpenRoomCard | null => {
  const d = data as Record<string, unknown> | null;
  if (!d || !str(d.ticker)) return null;
  const roles: OpenRole[] = ['owner', 'moderator', 'member', 'none'];
  return {
    ticker: str(d.ticker),
    name: str(d.name) || str(d.ticker),
    description: str(d.description) || null,
    visibility: d.visibility === 'invite' ? 'invite' : 'public',
    official: d.official === true,
    owner: norm(str(d.owner)),
    moderators: Array.isArray(d.moderators) ? d.moderators.map((h) => norm(String(h))) : [],
    closed: d.closed === true,
    role: roles.find((r) => r === d.role) ?? 'none',
    members: Array.isArray(d.members) ? d.members.map((h) => norm(String(h))).filter(Boolean) : [],
    inviteCode: str(d.invite_code) || null,
  };
};

export const isStaff = (card: Pick<OpenRoomCard, 'role'> | null | undefined) =>
  card?.role === 'owner' || card?.role === 'moderator';

export const memberRole = (card: OpenRoomCard, handle: string): OpenRole => {
  const h = norm(handle);
  if (h === card.owner) return 'owner';
  if (card.moderators.includes(h)) return 'moderator';
  return card.members.includes(h) ? 'member' : 'none';
};

/** Client-side check before the round trip; the server repeats it (open-rooms-rules.ts). */
export const roomNameProblem = (name: string): string | null => {
  const t = name.trim();
  if (t.length < 3) return 'At least 3 characters.';
  if (t.length > 60) return 'At most 60 characters.';
  return null;
};

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A bare code ("K7PX-M2QA", any case) or a link carrying `invite=<code>` / `/join/<code>`. */
export const parseInviteCode = (input: string): string | null => {
  const s = (input || '').trim();
  if (!s) return null;
  const m = s.match(/[?&]invite=([A-Za-z0-9-]+)/) || s.match(/\/join\/([A-Za-z0-9-]+)/);
  const raw = (m ? m[1] : s).replace(/[\s-]/g, '').toUpperCase();
  if (raw.length !== 8) return null;
  return [...raw].every((c) => CODE_ALPHABET.includes(c)) ? raw : null;
};

/** "K7PX-M2QA" for reading aloud / copying. */
export const formatInviteCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

/**
 * What the owner shares. Just the code for now: bitcoinchat.online has no /join/<code> page yet,
 * so a link would open nowhere. parseInviteCode already accepts such links for when it does.
 */
export const inviteMessage = (name: string, code: string) =>
  `Join "${name}" on bWallet. Invite code: ${formatInviteCode(code)} (Chat › Chatrooms › + New room › Have an invite code?)`;

/** Sort "Your rooms": newest activity first. */
export const byActivity = (a: ChatRoom, b: ChatRoom) => {
  const t = (r: ChatRoom) => Date.parse(r.last_message?.created_at ?? r.updated_at ?? r.created_at ?? '') || 0;
  return t(b) - t(a);
};

/** Public rooms worth listing: not already joined, matching the search, official first. */
export const browseList = (rooms: PublicRoom[], mine: ReadonlySet<string>, query: string): PublicRoom[] => {
  const q = query.trim().toLowerCase().replace(/^\$/, '');
  return rooms
    .filter((r) => !r.joined && !mine.has(r.ticker.toUpperCase()))
    .filter((r) => !q || `${r.name} ${r.ticker} ${r.description ?? ''}`.toLowerCase().includes(q))
    .sort((a, b) => Number(b.official) - Number(a.official) || b.memberCount - a.memberCount);
};

// ── Safety: block list (local, per bChat handle) and report reasons ──

export const REPORT_REASONS = ['Spam or scam', 'Harassment or hate', 'Sexual content', 'Violence or threats', 'Something else'] as const;

/** Drop messages from blocked handles (events stay, so the thread still makes sense). */
export const withoutBlocked = (messages: ChatMessage[], blocked: ReadonlySet<string>): ChatMessage[] =>
  blocked.size ? messages.filter((m) => m.kind === 'event' || !blocked.has(norm(m.author_handle))) : messages;

const blockKey = (me: string) => `bwallet.chat.blocked.${norm(me)}`;

export function loadBlocked(me: string): Set<string> {
  try {
    const v = localStorage.getItem(blockKey(me));
    return new Set(v ? (JSON.parse(v) as string[]).map(norm) : []);
  } catch {
    return new Set();
  }
}

export function setBlocked(me: string, target: string, block: boolean): Set<string> {
  const s = loadBlocked(me);
  const t = norm(target);
  if (block) s.add(t);
  else s.delete(t);
  try {
    localStorage.setItem(blockKey(me), JSON.stringify([...s].slice(-1000)));
  } catch {
    /* storage unavailable */
  }
  return s;
}
