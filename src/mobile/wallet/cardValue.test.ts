import { describe, expect, it } from 'bun:test';
import { cardTotals, cardValueText, creditsUsd, sumHoldings, unpricedNote, type CardValue } from './cardValue';
import type { Fx } from '../../utils/displayCurrency';

const USD: Fx = { currency: 'USD', usdPerUnit: 1 };
const GBP: Fx = { currency: 'GBP', usdPerUnit: 1.25 };
const RATE = 50; // US$ per BSV

describe('card value sums', () => {
  // 10M of A worth $1.00 in total and 10M of B worth $0.40: the card shows $1.40, never "20M tokens".
  const satsA = ((1.0 / RATE) * 1e8) / 10_000_000;
  const satsB = ((0.4 / RATE) * 1e8) / 10_000_000;
  const two = sumHoldings([
    { amount: 10_000_000, satsEach: satsA },
    { amount: 10_000_000, satsEach: satsB },
  ]);

  it('sums fiat values across tokens', () => {
    expect(cardTotals(two, RATE).usd).toBeCloseTo(1.4, 10);
    expect(cardValueText(two, 'usd', RATE, USD)).toBe('$1.40');
  });

  it('sums BSV values across tokens', () => {
    expect(cardTotals(two, RATE).sats).toBeCloseTo(2_800_000, 3);
    expect(cardValueText(two, 'bsv', RATE, USD)).toBe('BSV 0.028');
  });

  it('adds dollar-pegged and BSV-priced holdings in either unit', () => {
    const v = sumHoldings([
      { amount: 2, usdEach: 1 },
      { amount: 1, satsEach: 1e6 },
    ]); // $2 + 0.01 BSV ($0.50)
    expect(cardValueText(v, 'usd', RATE, USD)).toBe('$2.50');
    expect(cardValueText(v, 'bsv', RATE, USD)).toBe('BSV 0.05');
  });

  it('leaves unpriced tokens out and counts them', () => {
    const v = sumHoldings([{ amount: 10, satsEach: 1e6 }, { amount: 5 }, { amount: 7, satsEach: null }, { amount: 0 }]);
    expect(v.unpriced).toBe(2);
    expect(cardValueText(v, 'usd', RATE, USD)).toBe('$5.00');
    expect(unpricedNote(v)).toBe('2 unpriced');
    expect(unpricedNote(sumHoldings([{ amount: 1, usdEach: 1 }]))).toBe('');
  });

  it('follows the display currency', () => {
    expect(cardValueText(two, 'usd', RATE, GBP)).toBe('£1.12');
    const mnee: CardValue = { usd: 5, sats: 0, unpriced: 0 };
    expect(cardValueText(mnee, 'usd', RATE, USD)).toBe('$5.00');
    expect(cardValueText(mnee, 'usd', RATE, GBP)).toBe('£4.00');
  });

  it('says — instead of guessing when the BSV price is missing', () => {
    expect(cardValueText(two, 'usd', 0, USD)).toBe('—');
    const mnee: CardValue = { usd: 5, sats: 0, unpriced: 0 };
    expect(cardValueText(mnee, 'usd', 0, USD)).toBe('$5.00');
    expect(cardValueText(mnee, 'bsv', 0, USD)).toBe('—');
    expect(cardValueText({ usd: 0, sats: 0, unpriced: 0 }, 'bsv', 0, USD)).toBe('BSV 0.00');
  });

  it('prices bCredits at 1p each', () => {
    expect(creditsUsd(500, 1.25)).toBeCloseTo(6.25, 10);
    expect(creditsUsd(500, null)).toBeNull();
    expect(creditsUsd(0, null)).toBe(0);
  });
});
