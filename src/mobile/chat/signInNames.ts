/**
 * Which of this account's names may be used to sign in to bChatX or sign as (owner, 3 Nov 2026).
 *
 * The paymail server lists every plain name on the identity key, and its "main" can differ from bit-sign's active
 * handle: the owner's paymail main is b0ase@ while bit-sign keeps $b0ase as an inactive alias (an extra name,
 * `handles.is_active = false`) of $b0asex. An inactive alias can't be signed in as, so it is never offered as the
 * sign-in name: the account's active handle is used instead. bit-sign GET /api/bitsign/me/handles reports that flag
 * as `primary` (= is_active); the last answer is kept per account on this device.
 */
export type ServerHandle = { handle: string; primary: boolean };

const KEY = (account: string) => `bwx.bchat.handles:${account}`;
/** How long a cached list is trusted before the next session refreshes it. */
export const HANDLES_TTL_MS = 6 * 60 * 60 * 1000;

const norm = (h: string | null | undefined) => (h || '').trim().replace(/^[$@]/, '').split('@')[0].toLowerCase();

export const saveServerHandles = (account: string, handles: ServerHandle[], now = Date.now()) => {
  try {
    localStorage.setItem(KEY(account), JSON.stringify({ at: now, handles }));
  } catch {
    /* not remembered */
  }
};

export const loadServerHandles = (
  account: string | null | undefined,
): { at: number; handles: ServerHandle[] } | null => {
  if (!account) return null;
  try {
    const v = JSON.parse(localStorage.getItem(KEY(account)) || 'null') as {
      at?: unknown;
      handles?: unknown;
    } | null;
    if (!v || typeof v.at !== 'number' || !Array.isArray(v.handles)) return null;
    const handles = v.handles
      .filter((h): h is ServerHandle => !!h && typeof h.handle === 'string')
      .map((h) => ({ handle: norm(h.handle), primary: h.primary === true }));
    return { at: v.at, handles };
  } catch {
    return null;
  }
};

/** Due for a refresh: never fetched, or older than HANDLES_TTL_MS. */
export const handlesStale = (cached: { at: number } | null, now = Date.now()) =>
  !cached || now - cached.at >= HANDLES_TTL_MS;

/** A name bit-sign holds for this account, but not as its active handle. Pure. */
export const isInactiveAlias = (
  name: string | null | undefined,
  handles: readonly ServerHandle[] | null | undefined,
) => {
  const n = norm(name);
  return !!n && !!handles?.some((h) => norm(h.handle) === n && !h.primary);
};

/**
 * The name to sign in / sign as for a paymail alias: the alias itself, unless bit-sign says it is an inactive alias
 * of this account, then the account's active handle ('' when that isn't known). Pure.
 */
export const usableAlias = (alias: string | null | undefined, handles: readonly ServerHandle[] | null | undefined) => {
  const a = norm(alias);
  if (!a || !isInactiveAlias(a, handles)) return a;
  return norm(handles?.find((h) => h.primary)?.handle);
};

/** Paymail names that may be offered as a sign-in name: inactive aliases dropped. Pure. */
export const usableNames = <T extends { paymail: string }>(
  names: readonly T[],
  handles: readonly ServerHandle[] | null | undefined,
): T[] => names.filter((n) => !isInactiveAlias(n.paymail, handles));
