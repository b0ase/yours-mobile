/**
 * Wallet › PNEEs › lock icon (owner, 10 Oct 2026): the first sheet of Back PNEEs on the Lock screen asks how much
 * BSV to lock. Pure helpers here; the backing itself is still the existing Back PNEEs flow (BackPneeSheet).
 */

/** Route that opens the Lock screen in Back PNEEs mode. */
export const BACK_PNEE_ROUTE = '/m/lock?back=pnee';
export const BACK_PNEE_LABEL = 'Lock BSV to back PNEEs';
export const BACK_PNEE_QUESTION = 'How much BSV would you like to lock to back PNEEs?';
export const BACK_PNEE_EXPLAINER = 'PNEEs are backed only by BSV locked in public vaults.';
/** Preset amounts in BSV. */
export const BACK_PNEE_PRESETS = [0.1, 0.5, 1, 5] as const;
/** 10x collateral: $10 of BSV backs $1 of PNEE (see BackPneeSheet). */
export const BACK_PNEE_COLLATERAL = 10;

/** True when the Lock screen URL asks for Back PNEEs mode. */
export const isBackPneeMode = (search: string) => new URLSearchParams(search).get('back') === 'pnee';

/** Parses a typed BSV amount: a positive finite number with at most 8 decimals, else null. */
export const parseBsvAmount = (raw: string): number | null => {
  const s = raw.trim().replace(',', '.');
  if (!/^\d*\.?\d{0,8}$/.test(s) || s === '' || s === '.') return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Dollar value of the lock and the most PNEE (in dollars) it can back at 10x collateral. */
export const backPneeSummary = (bsv: number, rate: number) => {
  const usd = rate > 0 ? Math.round(bsv * rate * 100) / 100 : 0;
  return { usd, maxPneeUsd: Math.floor((usd / BACK_PNEE_COLLATERAL) * 100) / 100 };
};

/**
 * The Back PNEEs flow from Wallet › PNEEs › lock icon (owner, 10 Oct 2026), in this order and no other:
 *   card (Back PNEEs) → amount (how much BSV?) → build (the lock, filled in for the PNEEs pot; its review and
 *   type-LOCK confirm are the Lock screen's own) → done (where to find it) → back to the Wallet.
 * Closing the card or the amount sheet goes back to the Wallet too: entering from the Wallet never leaves the
 * user on Pots & Locks unless they choose "Open Pots & Locks".
 */
export type BackPneeStep = 'card' | 'amount' | 'build' | 'done' | 'wallet' | 'pots';
export type BackPneeEvent = 'lock' | 'continue' | 'back' | 'close' | 'locked' | 'toWallet' | 'toPots';

export const nextBackPneeStep = (step: BackPneeStep, ev: BackPneeEvent): BackPneeStep => {
  switch (step) {
    case 'card':
      return ev === 'lock' ? 'amount' : ev === 'close' || ev === 'back' ? 'wallet' : step;
    case 'amount':
      return ev === 'continue' ? 'build' : ev === 'back' ? 'card' : ev === 'close' ? 'wallet' : step;
    case 'build':
      return ev === 'locked' ? 'done' : ev === 'back' ? 'amount' : ev === 'close' ? 'wallet' : step;
    case 'done':
      return ev === 'toPots' ? 'pots' : ev === 'toWallet' || ev === 'close' || ev === 'back' ? 'wallet' : step;
    default:
      return step;
  }
};

/** Text on the done card. */
export const backPneeDoneTitle = (bsv: number) => `Locked ${bsv} BSV to back PNEEs.`;
export const BACK_PNEE_DONE_HINT = 'Find it any time in Pots & Locks → PNEEs pot.';
