/**
 * A room or invite link tapped on the phone lands in that room's chat, like Telegram (owner, 2 Nov 2026):
 *   member            → the room opens (open rooms, private rooms, DMs, token rooms I'm in)
 *   invite link       → claimed first (POST rooms/<ref>/claim: the link is the key), then the room opens
 *   not a member      → a token room's lock (bWalletX) or the store note (store build), else bChatX's own
 *                       door for the room in the bChatX frame, which explains and lets them join
 * Never silently back to the chat list. spaces/inviteLinks.ts parses the links and hands them here; the
 * Chatrooms page (tabs/ChatPage.tsx) takes the request once it is signed in, the same pending-then-event shape
 * as nav.ts. The decisions are pure and tested (roomLink.test.ts).
 */
import { BCHAT_PRIMARY_ORIGIN } from '../../services/bchatOrigin';
import type { RoomPage } from '../spaces/invite';
import { dmRooms } from './contacts';
import { memberRooms } from './memberRooms';
import type { ChatRoom } from './messages';
import { isOpenRoom } from './openRooms';
import { roomTokenGate } from './roomGate';
import { parseWebBappLink } from './signLink';
import { requestChatSegment } from './segmentNav';

export interface RoomLinkRequest {
  /** The room's ticker, or its clean address (`r_7kq2m9ab`, `name-r_7kq2m9ab`). */
  ref: string;
  /** A one-use join token (`/room/<ref>?invite=<token>`), claimed before the room opens. */
  invite: string | null;
  /** The bChatX page a non-member sees instead (e.g. the Space invite `/i/<code>`); null = worked out here. */
  door: string | null;
}

const EVENT = 'bwallet:chat-room-link';
let pending: RoomLinkRequest | null = null;

/** Ask the Chatrooms page to open a linked room (switches Chat to Chatrooms). */
export const requestRoomLink = (r: RoomLinkRequest) => {
  pending = { ...r, ref: r.ref.trim().replace(/^\$/, '') };
  requestChatSegment('rooms');
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* no window (tests) */
  }
};

export const takeRoomLink = (): RoomLinkRequest | null => {
  const r = pending;
  pending = null;
  return r;
};

export const onRoomLink = (fn: () => void) => {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
};

/** A room UUID's clean address, `r_` + its first 40 bits in base 36 (same as bit-sign lib/room-ref.ts refFromId). */
export const refFromId = (id: string): string => {
  const hex = String(id || '')
    .replace(/-/g, '')
    .slice(0, 10)
    .toLowerCase();
  if (!/^[0-9a-f]{10}$/.test(hex)) return '';
  return `r_${parseInt(hex, 16).toString(36).padStart(8, '0')}`;
};

const REF_TAIL = /(?:^|-)(r_[0-9a-z]{8})$/i;

/** The room a link names among my rooms (so I'm a member), by ticker or by clean address. */
export const findLinkedRoom = (rooms: readonly ChatRoom[], ref: string): ChatRoom | null => {
  const t = ref.trim().replace(/^\$/, '').toUpperCase();
  const short = REF_TAIL.exec(ref.trim())?.[1].toLowerCase() ?? '';
  return rooms.find((r) => r.ticker.toUpperCase() === t || (!!short && refFromId(r.id) === short)) ?? null;
};

export type LinkedRoomAction =
  /** A 1:1: the DMs page opens it. */
  | { kind: 'dm'; ticker: string }
  /** An open room or a private member room: open it. */
  | { kind: 'open' }
  /** A token room: the token-room flow (prove, open, or the lock). */
  | { kind: 'token'; key: string }
  /** A token room in a store build, where token rooms don't open. */
  | { kind: 'note' }
  /** Anything else I'm in: open it plainly. */
  | { kind: 'plain' };

/** How to open a room I'm a member of. */
export const linkedRoomAction = (room: ChatRoom, tokenRooms: boolean): LinkedRoomAction => {
  if (dmRooms([room]).length) return { kind: 'dm', ticker: room.ticker };
  if (isOpenRoom(room) || memberRooms([room]).length) return { kind: 'open' };
  const key = roomTokenGate(room.metadata)?.key;
  if (key) return tokenRooms ? { kind: 'token', key } : { kind: 'note' };
  return { kind: 'plain' };
};

/** bChatX's own page for a room I'm not in: the invite claim, the public room page, or the room (its 403 door). */
export const roomDoorPath = (ref: string, invite: string | null, publicPage: boolean): string => {
  const r = encodeURIComponent(ref.replace(/^\$/, ''));
  if (invite) return `/room/${r}?invite=${encodeURIComponent(invite)}`;
  return publicPage ? `/r/${r}` : `/room/${r}`;
};

export type NonMemberAction = { kind: 'token'; key: string } | { kind: 'note' } | { kind: 'door'; path: string };

/**
 * Not in my rooms. A token room (its public page names a gate) shows the existing lock with Buy in bWalletX and the
 * store note in a store build; an invite link never goes there (bit-sign refuses invite links in token rooms, so a
 * failed claim is for bChatX's door to explain). Everything else, including private rooms (no public page), gets
 * bChatX's door.
 */
export const nonMemberAction = (
  req: RoomLinkRequest,
  page: Pick<RoomPage, 'gate'> | null,
  tokenRooms: boolean,
): NonMemberAction => {
  const g = page?.gate;
  if (g && !req.invite) {
    if (!tokenRooms) return { kind: 'note' };
    if (g.key && (g.kind === 'bsv21' || g.kind === 'coll')) return { kind: 'token', key: g.key };
  }
  return { kind: 'door', path: req.door ?? roomDoorPath(req.ref, req.invite, !!page) };
};

/** The in-app route that shows a bChatX page in the bChatX frame (/m/bapp/bchatx?to=…), or null if it can't be framed. */
export const bchatxDoorRoute = (path: string): string | null =>
  parseWebBappLink(`https://web.bwalletx.com/bapp/bchatx?to=${encodeURIComponent(path)}`)?.route ?? null;

/** The same page as a full URL, for the in-app browser when the frame can't take it. */
export const bchatxDoorUrl = (path: string): string => new URL(path, BCHAT_PRIMARY_ORIGIN).toString();
