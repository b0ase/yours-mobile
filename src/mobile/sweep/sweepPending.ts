/**
 * Restore › SimplyCash: a SimplyCash wallet spreads coins over many addresses, so it can't be restored
 * the normal way. The card marks a pending sweep and goes to "create a wallet"; once the wallet exists,
 * SweepPrompt.tsx (on the Wallet page) opens the sweep with that preset.
 *
 * The mark is only for that one trip: choosing any other restore option clears it, and it expires
 * after MAX_AGE_MS, so a later ordinary restore or create never opens the sweep. A mark without a
 * time (written by the first version) counts as expired.
 */
const KEY = 'bwallet.sweep.pending';
export const MAX_AGE_MS = 15 * 60 * 1000;

type Mark = { preset: string; at: number };

export const markSweepPrompt = (preset: string, now = Date.now()) => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ preset, at: now } satisfies Mark));
  } catch {
    /* storage unavailable */
  }
};

export const clearSweepPrompt = () => {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
};

/** The pending preset, or null (none, expired or unreadable; those are cleared). */
export const getSweepPrompt = (now = Date.now()): string | null => {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const m = JSON.parse(raw) as Partial<Mark>;
    if (typeof m?.preset === 'string' && typeof m.at === 'number' && now - m.at >= 0 && now - m.at < MAX_AGE_MS)
      return m.preset;
  } catch {
    /* old plain-string mark */
  }
  clearSweepPrompt();
  return null;
};
