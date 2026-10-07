/**
 * How golden the wallet card is (0..1) for a BSV balance. Cosmetic only (owner, 5.1.77).
 *
 * Logarithmic, because most balances are tiny: log10(bsv / 0.001) / 5, clamped to 0..1.
 *   ≤ 0.001 BSV → 0 (near-black)   0.01 → 0.2   0.1 → 0.4   1 → 0.6   10 → 0.8   ≥ 100 → 1 (full gold)
 * Negative or NaN input → 0.
 */
export const CARD_GOLD_MIN_BSV = 0.001;
export const CARD_GOLD_MAX_BSV = 100;

export const cardGold = (bsv: number): number => {
  if (!(bsv > CARD_GOLD_MIN_BSV)) return 0; // also catches NaN
  if (bsv >= CARD_GOLD_MAX_BSV) return 1;
  const g = Math.log10(bsv / CARD_GOLD_MIN_BSV) / Math.log10(CARD_GOLD_MAX_BSV / CARD_GOLD_MIN_BSV);
  return Math.min(1, Math.max(0, g));
};

/** Gold level shown while the balance is hidden, so the colour does not give the balance away. */
export const CARD_GOLD_HIDDEN = 0.5;

/** The value for the card's --gold property: neutral when hidden, 0 while no balance is known. */
export const cardGoldLevel = (bsv: number, opts: { hidden?: boolean; known?: boolean } = {}): number =>
  opts.hidden ? CARD_GOLD_HIDDEN : opts.known === false ? 0 : cardGold(bsv);
