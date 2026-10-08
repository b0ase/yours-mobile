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
