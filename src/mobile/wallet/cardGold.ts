/**
 * How golden the wallet card is (0..1) for a BSV balance. Cosmetic only (owner, 5.1.77; linear since round 6).
 *
 * Linear from 0 BSV (black) to 100 BSV (full gold): clamp(bsv / 100, 0, 1).
 *   1 BSV → 0.01   10 → 0.1   50 → 0.5   ≥ 100 → 1
 * Negative or NaN input → 0.
 */
export const CARD_GOLD_MAX_BSV = 100;

export const cardGold = (bsv: number): number => {
  if (!(bsv > 0)) return 0; // also catches NaN
  return Math.min(1, bsv / CARD_GOLD_MAX_BSV);
};

/** Gold level shown while the balance is hidden, so the colour does not give the balance away. */
export const CARD_GOLD_HIDDEN = 0.5;

/** The value for the card's --gold property: neutral when hidden, 0 while no balance is known. */
export const cardGoldLevel = (bsv: number, opts: { hidden?: boolean; known?: boolean } = {}): number =>
  opts.hidden ? CARD_GOLD_HIDDEN : opts.known === false ? 0 : cardGold(bsv);
