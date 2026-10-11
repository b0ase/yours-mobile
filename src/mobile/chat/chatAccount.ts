/**
 * The wallet account (identity address) whose bit-sign session bChat calls use. Dependency-free so
 * the service provider can set it without pulling the chat client into every bundle.
 * Set at startup, on every storage refresh, and on account switch.
 */
export const LEGACY_SESSION_KEY = 'bwallet.bchat.session';

let chatAccount: string | null = null;

export const setChatAccount = (account: string | null | undefined) => {
  const next = account || null;
  if (next === chatAccount) return;
  chatAccount = next;
  try {
    // The pre-fix global session belongs to whichever account signed in first: never reuse it.
    localStorage.removeItem(LEGACY_SESSION_KEY);
  } catch {
    /* storage unavailable */
  }
};

export const getChatAccount = () => chatAccount;

/** The active account's BSV receive address, reported to bChatX for the profile balance (walletAddress.ts). */
let chatReceiveAddress: string | null = null;
export const setChatReceiveAddress = (address: string | null | undefined) => {
  chatReceiveAddress = address || null;
};
export const getChatReceiveAddress = () => chatReceiveAddress;

/**
 * One-time reset of every stored bChat / bit-sign session (8 Oct 2026). A bad server credential mapped the
 * richardwboase.gmail wallet to b0asex; it is deleted server-side, but a b0asex token saved under the gmail
 * account stays valid (bit-sign tokens can't be revoked). Bumping the version makes every account sign in fresh.
 */
export const SESSION_VERSION_KEY = 'bwallet.bchat.sessionVersion';
export const SESSION_VERSION = 2;

export const resetChatSessionsOnce = (ls: Storage | undefined = globalThis.localStorage): boolean => {
  try {
    if (!ls || Number(ls.getItem(SESSION_VERSION_KEY) || 0) >= SESSION_VERSION) return false;
    const drop: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith(LEGACY_SESSION_KEY) && k !== SESSION_VERSION_KEY) drop.push(k);
    }
    drop.forEach((k) => ls.removeItem(k));
    ls.setItem(SESSION_VERSION_KEY, String(SESSION_VERSION));
    return true;
  } catch {
    return false;
  }
};

resetChatSessionsOnce();
