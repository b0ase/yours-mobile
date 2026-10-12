/**
 * Wallet › PNEEs › lock icon (owner, 10 Oct 2026): Back PNEEs on the Lock screen. Since 12 Oct 2026 it opens a PNEE
 * vault (src/mobile/pnee/), not a plain time-lock: card → how much BSV → the exact confirm → done. Pure helpers.
 */

/** Route that opens the Lock screen in Back PNEEs mode. */
export const BACK_PNEE_ROUTE = '/m/lock?back=pnee';
export const BACK_PNEE_LABEL = 'Lock BSV to back PNEEs';
export const BACK_PNEE_QUESTION = 'How much BSV would you like to lock to back PNEEs?';
export const BACK_PNEE_EXPLAINER =
  'PNEEs are backed only by BSV locked in public vaults. You can mint up to a tenth of what you lock.';
/** Preset amounts in BSV. */
export const BACK_PNEE_PRESETS = [0.1, 0.5, 1, 5] as const;
/** 10x: $10 of BSV backs up to $1 of PNEEs (the vault's on-chain minimum ratio, 1000%). */
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
 * The Back PNEEs flow from Wallet › PNEEs › lock icon (owner, 10 Oct 2026; vaults 12 Oct 2026), in this order:
 *   card (Back PNEEs) → amount (how much BSV?) → confirm (exact sats and what it can back, then the wallet's own
 *   approval) → done (where to find it) → back to the Wallet.
 * Closing the card or the amount sheet goes back to the Wallet too: entering from the Wallet never leaves the
 * user on Pots & Locks unless they choose "Open Pots & Locks".
 */
export type BackPneeStep = 'card' | 'amount' | 'confirm' | 'done' | 'wallet' | 'pots';
export type BackPneeEvent = 'lock' | 'continue' | 'back' | 'close' | 'locked' | 'toWallet' | 'toPots';

export const nextBackPneeStep = (step: BackPneeStep, ev: BackPneeEvent): BackPneeStep => {
  switch (step) {
    case 'card':
      return ev === 'lock' ? 'amount' : ev === 'close' || ev === 'back' ? 'wallet' : step;
    case 'amount':
      return ev === 'continue' ? 'confirm' : ev === 'back' ? 'card' : ev === 'close' ? 'wallet' : step;
    case 'confirm':
      return ev === 'locked' ? 'done' : ev === 'back' ? 'amount' : ev === 'close' ? 'wallet' : step;
    case 'done':
      return ev === 'toPots' ? 'pots' : ev === 'toWallet' || ev === 'close' || ev === 'back' ? 'wallet' : step;
    default:
      return step;
  }
};

/** Text on the done card. */
export const backPneeDoneTitle = (bsv: number) => `Locked ${bsv} BSV in a PNEE vault.`;
export const BACK_PNEE_DONE_HINT = 'Mint PNEEs from it any time in Pots & Locks → Vaults.';
