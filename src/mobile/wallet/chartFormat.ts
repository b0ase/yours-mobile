import { currentFx, fiatSymbol, usdToFiat } from '../../utils/displayCurrency';

/** Shared by the BSV price chart (PriceChart.tsx) and the token market chart (TokenPriceChart.tsx, bWalletX only). */
// In the display currency (Settings › Currency).
export const usd = (dollars: number) => {
  const fx = currentFx();
  const v = usdToFiat(dollars, fx);
  const s = fiatSymbol(fx);
  return v >= 1 ? `${s}${v.toFixed(2)}` : v >= 0.01 ? `${s}${v.toFixed(4)}` : `${s}${v.toPrecision(2)}`;
};

export const GOLD = 'var(--bw-accent)';
export const UP = '#2ecc71';
export const DOWN = '#F04438';
export const MUTED = '#98A2B3';
