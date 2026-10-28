/**
 * Private member rooms: rooms I belong to that are neither a 1:1 (DMs lists those), an open room, nor a token room
 * (Chatrooms lists those two). Company boards, deal rooms, group chats — bit-sign's 'company' and 'group' piles.
 *
 * ⚠ Before this, Chatrooms showed only open + token rooms and DMs only 1:1s, so every other room a person was a member
 * of was in the rooms() response and on no screen. $BCORPBOARD (a board room with a document waiting for signature)
 * was one: its director got the push and could not find the room (owner, 28 Oct 2026). PURE.
 */
import { dmRooms } from './contacts';
import type { ChatRoom } from './messages';
import { isOpenRoom } from './openRooms';

export const memberRooms = (rooms: ChatRoom[]): ChatRoom[] => {
  const dms = new Set(dmRooms(rooms).map((r) => r.ticker.toUpperCase()));
  return rooms.filter((r) => {
    const m = (r.metadata ?? {}) as { tokenGate?: unknown; kind?: unknown };
    if (m.tokenGate || isOpenRoom(r)) return false;
    if (m.kind === 'direct' || r.list_kind === 'direct') return false;
    return !dms.has(r.ticker.toUpperCase());
  });
};
