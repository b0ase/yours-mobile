/**
 * Restore › SimplyCash: a SimplyCash wallet spreads coins over many addresses, so it can't be restored
 * the normal way. The card marks a pending sweep and goes to "create a wallet"; once the wallet exists,
 * SweepPrompt.tsx (on the Wallet page) opens the sweep with that preset.
 */
const KEY = 'bwallet.sweep.pending';

export const markSweepPrompt = (preset: string) => {
  try {
    localStorage.setItem(KEY, preset);
  } catch {
    /* storage unavailable */
  }
};
export const getSweepPrompt = (): string | null => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
export const clearSweepPrompt = () => {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
};
