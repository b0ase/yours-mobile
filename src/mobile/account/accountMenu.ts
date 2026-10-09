/**
 * The account menu at scale (owner, 8 Oct 2026): 100 accounts or 20 agents must not make the drawer huge.
 * The drawer shows only the current account plus "Switch account (N)" and "Agents (N)" rows; the sheets
 * behind them search, order (pinned, recent, then A–Z) and switch. Pure helpers here; UI in AccountSheets.tsx.
 */
import { LEGACY_SESSION_KEY } from '../chat/chatAccount';

export type MenuAccount = { id: string; name: string; handle: string; paymail: string };

const RECENT_KEY = 'bwallet.accounts.recent';
const PINNED_KEY = 'bwallet.accounts.pinned';
/** Recent accounts shown above the A–Z list. */
export const RECENT_LIMIT = 5;

const ls = (): Storage | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

const readJson = <T>(key: string, fallback: T, store = ls()): T => {
  try {
    const v = store?.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};

const writeJson = (key: string, v: unknown, store = ls()) => {
  try {
    store?.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
};

/** Last-used time per account id. */
export const getRecent = (store = ls()): Record<string, number> => readJson(RECENT_KEY, {}, store);
export const markAccountUsed = (id: string | undefined, now = Date.now(), store = ls()) => {
  if (!id) return;
  writeJson(RECENT_KEY, { ...getRecent(store), [id]: now }, store);
};

export const getPinned = (store = ls()): string[] => readJson<string[]>(PINNED_KEY, [], store);
export const togglePinned = (id: string, store = ls()): string[] => {
  const cur = getPinned(store);
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  writeJson(PINNED_KEY, next, store);
  return next;
};

/** Agent (and pot) accounts live under Agents, never in the account switcher. */
export const splitAccounts = <T extends { id: string }>(all: T[], isAgent: (id: string) => boolean) => ({
  people: all.filter((a) => !isAgent(a.id)),
  agents: all.filter((a) => isAgent(a.id)),
});

const norm = (s: string) => s.toLowerCase().replace(/^\$/, '').trim();

/** Case-insensitive match on name, handle or paymail ($ and spaces ignored). */
export const matchesQuery = (a: MenuAccount, query: string) => {
  const q = norm(query);
  if (!q) return true;
  return [a.name, a.handle, a.paymail].some((f) => !!f && norm(f).includes(q));
};

const alpha = (a: MenuAccount, b: MenuAccount) =>
  (a.name || a.handle || a.paymail).localeCompare(b.name || b.handle || b.paymail, undefined, { sensitivity: 'base' });

export type AccountSections<T extends MenuAccount> = { pinned: T[]; recent: T[]; rest: T[] };

/**
 * Pinned (A–Z), then up to RECENT_LIMIT most recently used, then everything else A–Z. A search filters every
 * section, so a match is never hidden behind the recent cut-off.
 */
export const orderAccounts = <T extends MenuAccount>(
  list: T[],
  { query = '', recent = {}, pinned = [] }: { query?: string; recent?: Record<string, number>; pinned?: string[] },
): AccountSections<T> => {
  const hits = list.filter((a) => matchesQuery(a, query));
  const pin = hits.filter((a) => pinned.includes(a.id)).sort(alpha);
  const unpinned = hits.filter((a) => !pinned.includes(a.id));
  const rec = unpinned
    .filter((a) => recent[a.id])
    .sort((a, b) => recent[b.id] - recent[a.id])
    .slice(0, RECENT_LIMIT);
  const rest = unpinned.filter((a) => !rec.includes(a)).sort(alpha);
  return { pinned: pin, recent: rec, rest };
};

/** Sign this account out of chat: drops only its stored bChat / bit-sign session. */
export const clearChatSessionFor = (id: string | undefined, store = ls()) => {
  if (!id) return;
  try {
    store?.removeItem(`${LEGACY_SESSION_KEY}:${id}`);
  } catch {
    /* storage unavailable */
  }
};

/** Accounts shown inline in the drawer (owner, 8 Oct 2026): the current one plus the most recent. */
export const INLINE_LIMIT = 4;

/**
 * The drawer's inline accounts: all of them when there are INLINE_LIMIT or fewer; otherwise the current one
 * plus the most recently used (then A–Z to fill), and `more` = true for the "All accounts (N)" row.
 */
export const inlineAccounts = <T extends MenuAccount>(
  people: T[],
  current: string | undefined,
  recent: Record<string, number> = {},
  limit = INLINE_LIMIT,
): { shown: T[]; more: boolean } => {
  if (people.length <= limit) return { shown: people, more: false };
  const cur = people.find((a) => a.id === current);
  const others = people.filter((a) => a.id !== current);
  const { recent: rec, rest } = orderAccounts(others, { recent });
  const shown = [...(cur ? [cur] : []), ...rec, ...rest].slice(0, limit);
  return { shown, more: true };
};
