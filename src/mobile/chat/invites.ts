/**
 * Unsolicited invites. Someone sends you 1 $ALICE (their personal token) → you now hold it →
 * the $ALICE room would appear in Chat. Instead of joining you silently, it shows as
 * "$alice invited you — Join / Ignore". Ignore hides it on this device; nothing is spent and
 * the token stays in the wallet. Join opens the room (the server admits holders).
 *
 * Pure decision + localStorage for the ignore / accept lists (per bChat handle).
 */
import type { TokenRoomEntry } from './tokenRooms';

export interface PersonalRoomInfo {
  /** Name the room's token is bound to ("alice"). */
  name: string;
  /** Handle that opened the room. */
  by: string;
}

export type InviteState =
  /** Not an invite: a room you opened, joined, accepted, or a token you bought. */
  | 'normal'
  /** Show "$alice invited you — Join / Ignore". */
  | 'invite'
  /** Ignored: not shown. */
  | 'hidden';

export function inviteState(
  entry: Pick<TokenRoomEntry, 'key' | 'status'>,
  personal: PersonalRoomInfo | null | undefined,
  me: string,
  lists: { ignored: ReadonlySet<string>; accepted: ReadonlySet<string> },
): InviteState {
  if (lists.ignored.has(entry.key)) return 'hidden';
  if (entry.status !== 'join' || !personal) return 'normal';
  if (lists.accepted.has(entry.key)) return 'normal';
  const norm = (h: string) => (h || '').replace(/^\$/, '').toLowerCase();
  if (norm(personal.by) === norm(me)) return 'normal';
  return 'invite';
}

export const inviteLine = (p: PersonalRoomInfo) => `$${p.name || p.by} invited you`;

const key = (handle: string, list: 'ignored' | 'accepted') => `bwallet.chat.invites.${list}.${handle.toLowerCase()}`;

export function loadInviteList(handle: string, list: 'ignored' | 'accepted'): Set<string> {
  try {
    const v = localStorage.getItem(key(handle, list));
    return new Set(v ? (JSON.parse(v) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function addToInviteList(handle: string, list: 'ignored' | 'accepted', roomKey: string): Set<string> {
  const s = loadInviteList(handle, list);
  s.add(roomKey);
  try {
    localStorage.setItem(key(handle, list), JSON.stringify([...s].slice(-500)));
  } catch {
    /* storage unavailable */
  }
  return s;
}
