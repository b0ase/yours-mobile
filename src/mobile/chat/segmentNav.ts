/**
 * Ask the Chat tab to show a segment (Chatrooms | DMs | Calls). Same pending-then-event shape as nav.ts: the Chat tab takes the request
 * when it mounts, or hears it if it is already showing.
 */
export type ChatSegmentId = 'rooms' | 'dms' | 'calls';

const EVENT = 'bwallet:chat-segment';
let pending: ChatSegmentId | null = null;

export const requestChatSegment = (seg: ChatSegmentId) => {
  pending = seg;
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* no window (tests) */
  }
};

export const takeChatSegment = (): ChatSegmentId | null => {
  const s = pending;
  pending = null;
  return s;
};

export const onChatSegment = (fn: () => void) => {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
};

/** Open the 1:1 with a bChat handle (from Calls): switches Chat to DMs, which takes the request. */
const DM_EVENT = 'bwallet:chat-dm';
let pendingDm: string | null = null;

export const requestDm = (handle: string) => {
  pendingDm = handle;
  requestChatSegment('dms');
  try {
    window.dispatchEvent(new Event(DM_EVENT));
  } catch {
    /* no window (tests) */
  }
};

export const takeDmRequest = (): string | null => {
  const h = pendingDm;
  pendingDm = null;
  return h;
};

export const onDmRequest = (fn: () => void) => {
  window.addEventListener(DM_EVENT, fn);
  return () => window.removeEventListener(DM_EVENT, fn);
};

/**
 * Open a room by its ticker (a tapped push notification, src/mobile/push): switches Chat to DMs or
 * Chatrooms, whose page takes the request once its room list has loaded.
 */
const ROOM_EVENT = 'bwallet:chat-room-ticker';
let pendingRoom: { ticker: string; dm: boolean } | null = null;

export const requestRoomByTicker = (ticker: string, dm: boolean) => {
  pendingRoom = { ticker: ticker.replace(/^\$/, '').toUpperCase(), dm };
  requestChatSegment(dm ? 'dms' : 'rooms');
  try {
    window.dispatchEvent(new Event(ROOM_EVENT));
  } catch {
    /* no window (tests) */
  }
};

/** The pending ticker if it is for this segment (dm = the DMs page), else null (left for the other). */
export const takeRoomTicker = (dm: boolean): string | null => {
  if (!pendingRoom || pendingRoom.dm !== dm) return null;
  const t = pendingRoom.ticker;
  pendingRoom = null;
  return t;
};

export const onRoomTicker = (fn: () => void) => {
  window.addEventListener(ROOM_EVENT, fn);
  return () => window.removeEventListener(ROOM_EVENT, fn);
};
