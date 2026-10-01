/**
 * Cross-tab hand-off for token rooms: "Open room" (Wallet token page, Market token page) → Chat,
 * and "Buy in Market" (a locked room) → that token's Market page. The target tab takes the
 * request when it mounts, or hears it if it is already mounted.
 */
export type TokenRef = { kind: 'bsv21' | 'coll'; id: string };

const EVENT = 'bwallet:token-nav';
const pending: { chat: string | null; market: TokenRef | null } = { chat: null, market: null };

const fire = () => {
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    /* no window (tests) */
  }
};

/** Ask the Chat tab to open (or start) the room for a token key (`bsv21:<id>` / `coll:<id>`). */
export const requestChatRoom = (key: string) => {
  pending.chat = key;
  fire();
};
export const takeChatRoom = (): string | null => {
  const k = pending.chat;
  pending.chat = null;
  return k;
};

/** Ask the Market tab to open a token's page. */
export const requestMarketToken = (ref: TokenRef) => {
  pending.market = ref;
  fire();
};
export const takeMarketToken = (): TokenRef | null => {
  const r = pending.market;
  pending.market = null;
  return r;
};

export const onTokenNav = (fn: () => void) => {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
};
