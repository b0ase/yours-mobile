import { describe, expect, it } from 'vitest';
import { hasReturnsWording, returnsWords } from './returnsWording';

describe('returns wording filter', () => {
  it('flags promises of returns, case-insensitively', () => {
    for (const t of [
      'Huge PROFITS for holders',
      'Earn returns every week',
      'Monthly dividend paid in BSV',
      'Dividends to holders',
      'High yield staking',
      '20% APY',
      'apr of 5%',
      'Guaranteed to go up',
      'A great investment',
      'Passive income forever',
      'Massive ROI',
      'profit-sharing token',
      '10x gains',
    ])
      expect(hasReturnsWording(t), t).toBe(true);
  });
  it('does not flag look-alikes', () => {
    for (const t of [
      'See our returns policy',
      'Free returns on merch',
      'Ammo for Chain Frogger',
      'Holders get airdrops and room access',
      'Yield sign at the junction',
      'Profit and loss of the game studio are not shared',
      'reinvestigate the mempool',
      'Approve the APRIL launch',
      'droid',
    ])
      expect(hasReturnsWording(t), t).toBe(false);
  });
  it('lists words as written', () => {
    expect(returnsWords('Dividends and APY')).toEqual(['Dividends', 'APY']);
  });
});
