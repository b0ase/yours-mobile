import { describe, expect, test } from 'bun:test';
import { AD_PAGE_URL, AD_PRICE_USD_PER_WEEK, adSlideText } from './adSlot';

describe('Store showcase ad slide', () => {
  test('says plainly what it is and what it costs', () => {
    expect(adSlideText()).toEqual({
      kind: 'Advertise',
      title: 'Your ad here',
      blurb: `For Bitcoin · from $${AD_PRICE_USD_PER_WEEK} a week`,
    });
    expect(adSlideText(8).blurb).toBe('For Bitcoin · from $8 a week');
  });

  test('opens the public advert page, never a payment address', () => {
    expect(AD_PAGE_URL).toBe('https://bwalletx.com/advertise');
    expect(AD_PAGE_URL).not.toMatch(/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/);
  });
});
