import type { AgentMessage } from './agent';

/**
 * The Ask b conversation shared by the floating bar (AskBar on every Desktop page) and the full /m/ask-b page,
 * so "Open full chat" carries it over (owner, 12 Oct 2026). Memory only, per account; never stored.
 */
let thread: { account: string; messages: AgentMessage[]; id: string } | null = null;

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;

export const loadThread = (account: string | null | undefined): AgentMessage[] =>
  account && thread?.account === account ? thread.messages : [];

export const saveThread = (account: string | null | undefined, messages: AgentMessage[]) => {
  if (!account) return;
  // A cleared (empty) conversation starts a new chat, so it gets a new id and a new name (chatName.ts).
  const same = thread?.account === account;
  const cleared = same && !!thread?.messages.length && messages.length === 0;
  thread = { account, messages, id: same && !cleared && thread ? thread.id : newId() };
};

/** This conversation's id (memory only, like the thread); names it via chatName.ts. */
export const threadId = (account: string | null | undefined): string | null => {
  if (!account) return null;
  if (thread?.account !== account) thread = { account, messages: [], id: newId() };
  return thread.id;
};

/** One line added to b's instructions so answers fit the screen the user is looking at. */
export const screenContext = (pathname: string | undefined): string => {
  if (!pathname) return '';
  const screen = pathname.replace(/^\/m\/?/, '').split(/[/?#]/)[0] || 'home';
  return `\n\nThe user is on the "${screen}" screen of bWalletX (${pathname.slice(0, 120)}). Prefer answers about that screen when relevant.`;
};
