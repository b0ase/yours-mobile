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

/**
 * Hold the b to talk (phone/Dock.tsx): the transcript arrives as the draft with SEND set, and b's page sends it
 * through its normal send() (consent sheet, price, confirm). NOTE = a short line shown above the composer
 * when voice didn't work (the keyboard is up instead).
 */
const SEND = 'bwallet.agentDraftSend';
const NOTE = 'bwallet.agentNote';

/** Fired after a voice handoff, so an already open b page picks it up (it only reads the handoff on mount). */
export const AGENT_HANDOFF_EVENT = 'bwallet:agent-handoff';
const announce = () => queueMicrotask(() => window.dispatchEvent(new Event(AGENT_HANDOFF_EVENT)));

export const setAgentVoice = (text: string) => {
  setAgentDraft(text);
  try {
    sessionStorage.setItem(SEND, '1');
  } catch {
    /* the text still arrives typed in */
  }
  announce();
};
export const setAgentNote = (note: string) => {
  try {
    sessionStorage.setItem(NOTE, note);
  } catch {
    /* no note */
  }
  announce();
};
const take = (k: string) => {
  try {
    const v = sessionStorage.getItem(k) ?? '';
    sessionStorage.removeItem(k);
    return v;
  } catch {
    return '';
  }
};
export const takeAgentSend = () => take(SEND) === '1';
export const takeAgentNote = () => take(NOTE);
