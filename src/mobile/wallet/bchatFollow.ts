/**
 * bChatX follows the wallet account (owner, 10 Oct 2026): "a user's bWalletX handle is the handle they
 * are signed into bChatX with by default". The wallet card no longer explains mismatches; instead the
 * bChatX session quietly follows the active account, and choice and privacy live in Settings › bChatX.
 *
 * Per account, stored on this device:
 *   account → sign in to bChatX as this account, under its paymail name (default)
 *   custom  → sign in as this account, but keep the bChatX name the user chose there
 *   off     → never sign this account in to bChatX; any session is dropped
 */
export type BchatPref = { mode: 'account' } | { mode: 'custom' } | { mode: 'off' };

export interface FollowStatus {
  at: number;
  ok: boolean;
  /** The bChatX handle now in use, when ok. */
  handle?: string;
  error?: string;
}

const prefKey = (account: string) => `bwx.bchat.pref:${account}`;
const statusKey = (account: string) => `bwx.bchat.follow:${account}`;
/** A failed attempt waits this long before the next automatic try (manual retry is always allowed). */
export const FOLLOW_RETRY_MS = 10 * 60 * 1000;

export const loadBchatPref = (account: string | null | undefined): BchatPref => {
  if (!account) return { mode: 'account' };
  try {
    const v = JSON.parse(localStorage.getItem(prefKey(account)) || 'null') as BchatPref | null;
    if (v && (v.mode === 'account' || v.mode === 'custom' || v.mode === 'off')) return { mode: v.mode };
  } catch {
    /* storage unavailable or bad JSON: default */
  }
  return { mode: 'account' };
};

export const saveBchatPref = (account: string, pref: BchatPref) => {
  try {
    localStorage.setItem(prefKey(account), JSON.stringify(pref));
  } catch {
    /* not remembered */
  }
};

export const loadFollowStatus = (account: string | null | undefined): FollowStatus | null => {
  if (!account) return null;
  try {
    const v = JSON.parse(localStorage.getItem(statusKey(account)) || 'null') as FollowStatus | null;
    return v && typeof v.at === 'number' ? v : null;
  } catch {
    return null;
  }
};

export const saveFollowStatus = (account: string, s: FollowStatus) => {
  try {
    localStorage.setItem(statusKey(account), JSON.stringify(s));
  } catch {
    /* not remembered */
  }
};

/** An automatic attempt is due unless the last one failed less than FOLLOW_RETRY_MS ago. */
export const followDue = (last: FollowStatus | null, now = Date.now()) =>
  !last || last.ok || now - last.at >= FOLLOW_RETRY_MS;

const norm = (h: string | null | undefined) => (h || '').trim().replace(/^[$@]/, '').toLowerCase();

/** The paymail's name part (`b0asey@bwalletx.com` → `b0asey`), or '' without one. */
export const aliasOf = (paymail: string | null | undefined) => norm((paymail || '').split('@')[0]);

export type FollowAction =
  /** Nothing to do. */
  | 'none'
  /** Privacy: drop this account's bChatX session and stay signed out. */
  | 'clear'
  /** Drop any session and sign in fresh as this account (no session, or one that belongs to someone else). */
  | 'signin'
  /** Signed in as this account but under another name: ask bChatX to use the paymail name. */
  | 'adopt';

export const decideFollow = (i: {
  pref: BchatPref;
  /** The stored bChatX session's handle for this account, or null. */
  sessionHandle: string | null | undefined;
  /** This account's paymail name ('' without one). */
  alias: string;
  /** True when the stored session belongs to another wallet account or identity (useChatIdentity). */
  mismatch: boolean;
}): FollowAction => {
  const session = norm(i.sessionHandle);
  if (i.pref.mode === 'off') return session ? 'clear' : 'none';
  if (i.mismatch || !session) return 'signin';
  if (i.pref.mode === 'account' && i.alias && session !== i.alias) return 'adopt';
  return 'none';
};
