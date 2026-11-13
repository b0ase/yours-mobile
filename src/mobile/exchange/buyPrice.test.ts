import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Listing } from '../market/indexer';
import { bestBuyable, buyPriceLabel, compactCount, forSaleFirst, listingTokens, saleState } from './buyPrice';

const L = (priceSats: number, perTokenSats: number, buyable = true): Listing => ({
  outpoint: `${'b'.repeat(64)}_${priceSats}_${perTokenSats}`,
  priceSats,
  amount: String(priceSats / perTokenSats),
  perTokenSats,
  label: 'lot',
  origin: null,
  seller: '1x',
  buyable,
});

describe('bestBuyable (the listing "Buy at best price" opens)', () => {
  it('picks the cheapest per token among buyable listings', () => {
    const cheapLot = L(1_000, 10); // 100 tokens at 10 sats
    const bestPer = L(5_000, 2); // 2,500 tokens at 2 sats
    expect(bestBuyable([cheapLot, bestPer])).toBe(bestPer);
  });
  it('skips listings that cannot be bought in-app', () => {
    const notBuyable = L(500, 1, false);
    const ok = L(2_000, 4);
    expect(bestBuyable([notBuyable, ok])).toBe(ok);
  });
  it('is null when nothing can be bought', () => {
    expect(bestBuyable([])).toBeNull();
    expect(bestBuyable([L(500, 1, false)])).toBeNull();
  });
  it('counts the tokens in a listing', () => {
    expect(listingTokens(L(5_000, 2))).toBe(2_500);
    expect(listingTokens({ ...L(5_000, 2), perTokenSats: undefined })).toBeNull();
  });
});

describe('card price label', () => {
  it('shows dollars at the rate, BSV when the rate is unknown', () => {
    // $50 / BSV: 100,000 sats = $0.05.
    expect(buyPriceLabel(100_000, 50)).toBe('$0.05');
    expect(buyPriceLabel(100_000, 0)).toBe('0.001 BSV');
  });
  it('shortens token counts', () => {
    expect(compactCount(950)).toBe('950');
    expect(compactCount(1_200)).toBe('1.2K');
    expect(compactCount(3_400_000)).toBe('3.4M');
    expect(compactCount(250_000_000)).toBe('250M');
  });
});

describe('for sale first', () => {
  it('knows checking, for sale and not for sale', () => {
    expect(saleState(undefined)).toBe('checking');
    expect(saleState(null)).toBe('checking');
    expect(saleState([L(100, 1)])).toBe('for-sale');
    expect(saleState([L(100, 1, false)])).toBe('not-for-sale');
    expect(saleState([])).toBe('not-for-sale');
  });
  it('orders for sale, then checking, then not for sale, keeping the list order inside each group', () => {
    const state = { a: 'not-for-sale', b: 'for-sale', c: 'checking', d: 'for-sale', e: 'not-for-sale' } as const;
    const rows = ['a', 'b', 'c', 'd', 'e'] as const;
    expect(forSaleFirst(rows, (r) => state[r])).toEqual(['b', 'd', 'c', 'a', 'e']);
  });
});

describe('Exchange token cards stay minimal (owner, 13 Nov 2026)', () => {
  const src = readFileSync(join(import.meta.dir, 'TokenBoard.tsx'), 'utf8');
  const card = src.slice(src.indexOf('const TokenCard = ('), src.indexOf('export const TokenBoard'));
  it('shows icon, $NAME, the price to buy and one Buy button', () => {
    expect(card).toContain('<TokenIcon');
    expect(card).toContain('bestBuyable(listings)');
    expect(card).toContain('Not for sale');
    expect(card).toMatch(/>\s*Buy\s*</);
    expect(card).toContain('min-h-[44px]');
  });
  it('carries none of the facts that moved to Details', () => {
    for (const gone of ['ScoreRing', 'badges', 'deployer', 'ageLabel', 'capLabel', 'Supply', 'burned', 'changeLabel'])
      expect(card).not.toContain(gone);
  });
  it('shows the risk line on the board', () => {
    expect(src).toContain('{RISK_LINE}');
  });
});
