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
