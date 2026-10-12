import type { AgentMessage } from './agent';

/**
 * The Ask b conversation shared by the floating bar (AskBar on every Desktop page) and the full /m/ask-b page,
 * so "Open full chat" carries it over (owner, 12 Oct 2026). Memory only, per account; never stored.
 */
let thread: { account: string; messages: AgentMessage[] } | null = null;

export const loadThread = (account: string | null | undefined): AgentMessage[] =>
  account && thread?.account === account ? thread.messages : [];

export const saveThread = (account: string | null | undefined, messages: AgentMessage[]) => {
  if (account) thread = { account, messages };
};

/** One line added to b's instructions so answers fit the screen the user is looking at. */
export const screenContext = (pathname: string | undefined): string => {
  if (!pathname) return '';
  const screen = pathname.replace(/^\/m\/?/, '').split(/[/?#]/)[0] || 'home';
  return `\n\nThe user is on the "${screen}" screen of bWalletX (${pathname.slice(0, 120)}). Prefer answers about that screen when relevant.`;
};
