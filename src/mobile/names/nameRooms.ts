import type { OneSatContext } from '@1sat/actions';
import type { BchatClient } from '../chat/api';
import { PAYMAIL_ALIAS_RE } from './paymail';

/**
 * One free room per name (owner, 26 Oct 2026). Every name the person claims from a linked identity (X, Google, GitHub,
 * LinkedIn) gets its own meeting room under that name; one of them is primary, the same primary chosen on Choose your
 * handle. Rooms need no token: the personal token launcher is separate and optional ("Launch your tokens"). The owner
 * controls each room (guests and visitors in for free if they choose; live Spaces) and can sign to prove control.
 *
 * Today's free room: bit-sign POST /api/bitsign/rooms/open (BchatClient.createOpenRoom), the same "Open a room" the Chat
 * tab uses. It costs nothing and mints nothing. Its limits (see the PR):
 *  - the room is owned by the signed-in bChatX session handle (normally the primary name), not bound to `$alias`;
 *  - there is no "the room for $alias" lookup, so the wallet keeps alias → ticker here (this device only);
 *  - bit-sign caps room creation per day.
 * TODO(bit-sign): POST /api/bitsign/rooms/name { alias, identityKey, timestamp, signature } — the name's owner proves
 * it with the same BRC-43 signed message as paymail claims; idempotent (returns the existing room for that alias);
 * free; and GET /api/bitsign/rooms/name/:alias → { ticker }. Then ensureNameRoom calls that instead.
 */

export type NameRoom = { alias: string; ticker: string; primary?: boolean };

const KEY = (id: string) => `bwallet.nameRooms.${id}`;
const EVENT = 'bwallet-name-rooms';

export const getNameRooms = (id: string | undefined): NameRoom[] => {
  if (!id) return [];
  try {
    const v = JSON.parse(localStorage.getItem(KEY(id)) || '[]') as NameRoom[];
    return Array.isArray(v) ? v.filter((r) => r?.alias && r?.ticker) : [];
  } catch {
    return [];
  }
};
const save = (id: string, rooms: NameRoom[]) => {
  try {
    localStorage.setItem(KEY(id), JSON.stringify(rooms));
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* private mode / tests */
  }
};
export const onNameRoomsChange = (cb: () => void) => {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
};

/** Primary first, then the rest in claim order. Pure. */
export const orderNameRooms = (rooms: readonly NameRoom[], primary?: string): NameRoom[] => {
  const p = primary || rooms.find((r) => r.primary)?.alias || '';
  return [...rooms.filter((r) => r.alias === p), ...rooms.filter((r) => r.alias !== p)];
};

/** Record a room for a name; `primary` moves the primary flag to it. Pure. */
export const withNameRoom = (rooms: readonly NameRoom[], room: NameRoom): NameRoom[] => {
  const rest = rooms.filter((r) => r.alias !== room.alias).map((r) => (room.primary ? { ...r, primary: false } : r));
  return [...rest, room];
};

export const setPrimaryNameRoom = (id: string, alias: string) =>
  save(
    id,
    getNameRooms(id).map((r) => ({ ...r, primary: r.alias === alias })),
  );

type RoomClient = Pick<BchatClient, 'createOpenRoom'>;

/**
 * The room for $alias: the one recorded here, else a new free room. Never pays, never mints. Invite-only by default:
 * the owner lets guests in from the room's own settings.
 */
export async function ensureNameRoom(
  client: RoomClient,
  id: string,
  alias: string,
  primary = false,
): Promise<NameRoom> {
  const a = alias.trim().toLowerCase();
  if (!id || !PAYMAIL_ALIAS_RE.test(a)) throw new Error('Not a name');
  const have = getNameRooms(id).find((r) => r.alias === a);
  if (have) {
    if (primary && !have.primary) setPrimaryNameRoom(id, a);
    return { ...have, primary: primary || have.primary };
  }
  // TODO(bit-sign): a name-bound room endpoint (see the header). Until then: the free open room, named $alias.
  const r = await client.createOpenRoom({
    name: `$${a}`,
    description: `${a}'s room`,
    visibility: 'invite',
  });
  const room: NameRoom = { alias: a, ticker: r.ticker, primary };
  save(id, withNameRoom(getNameRooms(id), room));
  return room;
}

/** Make rooms for freshly claimed names (best effort; a failure leaves the card to try again on open). */
export async function ensureNameRooms(
  ctx: OneSatContext,
  id: string,
  aliases: readonly string[],
  primary: string,
): Promise<void> {
  const { chatClient } = await import('../tickets/mintTicket');
  const c = await chatClient(ctx);
  for (const a of aliases) await ensureNameRoom(c, id, a, a === primary).catch(() => undefined);
}
