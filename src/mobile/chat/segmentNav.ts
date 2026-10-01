/**
 * Ask the Chat tab to show a segment (Rooms | Feed | Calls) — from the top bar's Feed and
 * phone buttons. Same pending-then-event shape as nav.ts: the Chat tab takes the request
 * when it mounts, or hears it if it is already showing.
 */
export type ChatSegmentId = 'rooms' | 'feed' | 'calls';

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
