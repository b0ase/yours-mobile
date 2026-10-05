/**
 * Open b with a request already typed in (owner, 6 Oct 2026: the Mint screen sends contracts, strategies and apps to b).
 * One-shot: the Agent page takes it on mount and clears it, so it never reappears.
 */
const KEY = 'bwallet.agentDraft';

export const setAgentDraft = (text: string) => {
  try {
    sessionStorage.setItem(KEY, text);
  } catch {
    /* storage unavailable: b just opens empty */
  }
};

export const takeAgentDraft = (): string => {
  try {
    const t = sessionStorage.getItem(KEY) ?? '';
    sessionStorage.removeItem(KEY);
    return t;
  } catch {
    return '';
  }
};
