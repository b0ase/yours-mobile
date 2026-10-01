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
