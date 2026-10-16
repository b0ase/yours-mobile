import { describe, expect, test } from 'bun:test';
import { EXAMPLE_SUBSCRIPTIONS, draftToListing, feeSplitLabel, priceLabel, splitCents, visible } from './bstore';

const draft = {
  seller: 'alice@bwalletx.com',
  category: 'stickers',
  title: 'Gold cats',
  description: 'Twelve gold cat stickers for chat.',
  images: [],
  price: '1.50',
  type: 'one-off' as const,
};

describe('bStore model', () => {
  test('fee split 80/20, seller keeps rounding', () => {
    expect(feeSplitLabel()).toBe('Seller gets 80%, bStore 20%');
    expect(splitCents(100)).toEqual({ seller: 80, bstore: 20 });
    expect(splitCents(99)).toEqual({ seller: 80, bstore: 19 });
  });
  test('valid draft becomes a pending listing', () => {
    const { errors, listing } = draftToListing(draft, 'x1');
    expect(errors).toEqual([]);
    expect(listing?.status).toBe('pending');
    expect(listing?.priceCents).toBe(150);
  });
  test('rejects unknown categories, bad prices and periodless subscriptions', () => {
    expect(draftToListing({ ...draft, category: 'weapons' }, 'x').errors.length).toBe(1);
    expect(draftToListing({ ...draft, price: '0' }, 'x').errors.length).toBe(1);
    expect(draftToListing({ ...draft, type: 'subscription' }, 'x').errors.length).toBe(1);
  });
  test('subscription keeps period and perks', () => {
    const { listing } = draftToListing({ ...draft, type: 'subscription', period: 'month', perks: 'a\n\nb' }, 'x');
    expect(listing?.perks).toEqual(['a', 'b']);
    expect(priceLabel(listing!)).toBe('$1.50 / month');
  });
  test('only live listings are visible; examples are labelled', () => {
    expect(visible([{ ...EXAMPLE_SUBSCRIPTIONS[0], status: 'pending' }])).toEqual([]);
    expect(EXAMPLE_SUBSCRIPTIONS.every((l) => l.example)).toBe(true);
  });
});
