import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  centsLabel,
  flatCents,
  joinSheetTitle,
  listingPriceSats,
  pickCurveListing,
  quoteAction,
  recordPurchase,
  refillPlan,
  supporterBadge,
  type CurveSales,
} from './curveSales';
import { parsePeople } from './people';

const A = 'a'.repeat(64);
const sales = (o: Partial<CurveSales> = {}): CurveSales => ({
  open: true,
  tranche: 10,
  pack: 1,
  listings: [],
  priced_at_holders: 0,
  ...o,
});

describe('curve sales: buyer', () => {
  test('one sheet title: Join $kim’s room — 1¢ (Supporter #3)', () => {
    expect(joinSheetTitle('kim', 1, 3)).toBe("Join $kim's room — 1¢ (Supporter #3)");
    expect(joinSheetTitle('kim', 150, null)).toBe("Join $kim's room — $1.50");
    expect(centsLabel(0.5)).toBe('0.5¢');
  });
  test('quote refusals: own token hides, already joined opens the room', () => {
    expect(quoteAction({ ok: false, reason: 'own_token', message: '' })).toBe('hide');
    expect(quoteAction({ ok: false, reason: 'already_bought', message: '' })).toBe('open-room');
    expect(quoteAction({ ok: false, reason: 'not_listed', message: '' })).toBe('resale');
    expect(quoteAction({ ok: true, price_usd_cents: 1, price_sats: 2, supporter: 1, pack: 1, listings: [] })).toBe(
      'buy',
    );
  });
  test('buys only a registered curve listing (never a resale), cheapest first', () => {
    const market = [
      { outpoint: `${A}.0`, priceSats: 50, buyable: true },
      { outpoint: `${A}.1`, priceSats: 20, buyable: true },
      { outpoint: `${'b'.repeat(64)}_0`, priceSats: 1, buyable: true },
      { outpoint: `${A}.2`, priceSats: 5, buyable: false },
    ];
    expect(pickCurveListing([`${A}_0`, `${A}_1`, `${A}_2`], market)?.outpoint).toBe(`${A}.1`);
    expect(pickCurveListing([], market)).toBeNull();
  });
  test('badge text', () => {
    expect(supporterBadge(1)).toBe('Supporter #1');
    expect(supporterBadge(null)).toBeNull();
  });
  test('records the purchase, retrying until the tx is on chain', async () => {
    let n = 0;
    const f = (async () => {
      n++;
      return new Response(JSON.stringify(n < 3 ? { ok: false, reason: 'not_found' } : { ok: true, supporter: 4 }));
    }) as unknown as typeof fetch;
    expect(await recordPurchase(`${A}_0`, 'c'.repeat(64), f, 5, 0)).toEqual({ ok: true, supporter: 4 });
    expect(n).toBe(3);
  });
  test('a refusal is not retried', async () => {
    let n = 0;
    const f = (async () => (
      n++,
      new Response(JSON.stringify({ ok: false, reason: 'already_bought' }), { status: 409 })
    )) as unknown as typeof fetch;
    expect((await recordPurchase(`${A}_0`, 'c'.repeat(64), f, 5, 0)).reason).toBe('already_bought');
    expect(n).toBe(1);
  });
});

describe('curve sales: seller', () => {
  test('closed → cancel everything live', () => {
    expect(refillPlan(sales({ open: false }), ['x', 'y'], 0, 'curve')).toEqual({ cancel: ['x', 'y'], list: 0 });
    expect(refillPlan(sales(), ['x'], 0, 'off')).toEqual({ cancel: ['x'], list: 0 });
  });
  test('open → list the gap', () => {
    expect(refillPlan(sales({ tranche: 10 }), ['x', 'y'], 3, 'curve')).toEqual({ cancel: [], list: 8 });
  });
  test('holders moved ≥10 since pricing → re-price the whole tranche (curve only)', () => {
    expect(refillPlan(sales({ priced_at_holders: 0 }), ['x'], 10, 'curve')).toEqual({ cancel: ['x'], list: 10 });
    expect(refillPlan(sales({ priced_at_holders: 0 }), ['x'], 50, 'flat')).toEqual({ cancel: [], list: 9 });
  });
  test('price in sats at the USD rate', () => {
    expect(listingPriceSats(1, 1, 50)).toBe(20000);
    expect(listingPriceSats(1, 0, 50)).toBe(0);
  });
  test('flat price form', () => {
    expect(flatCents('0.25')).toBe(25);
    expect(flatCents('$1')).toBe(100);
    expect(flatCents('0')).toBeNull();
    expect(flatCents('abc')).toBeNull();
  });
  test('public list carries sales_open', () => {
    const rows = parsePeople({ tokens: [{ token_id: `${A}_0`, handle: 'kim', sales_open: true }] });
    expect(rows[0].salesOpen).toBe(true);
  });
});

describe('copy rules', () => {
  test('no profit / price-going-up wording in the sale UI', () => {
    for (const f of ['curveSales.ts', 'SellMyToken.tsx', 'PeopleMarket.tsx']) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8').replace(/^\s*(\/\/|\*).*$/gm, '');
      expect(src).not.toMatch(/\b(profit|invest|moon|price goes up|gains?|ROI)\b/i);
    }
  });
  test('Buy & chat asks for a quote before the sheet and records the purchase after', () => {
    const src = readFileSync(new URL('./PeopleMarket.tsx', import.meta.url), 'utf8');
    expect(src.indexOf('fetchQuote(')).toBeGreaterThan(0);
    expect(src.indexOf('recordPurchase(')).toBeGreaterThan(src.indexOf('buyBsv21.execute('));
  });
});
