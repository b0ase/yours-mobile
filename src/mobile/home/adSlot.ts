/**
 * The "Your ad here" slide at the far right of the Store showcase (owner, 20 Oct 2026). Anyone can put their own
 * thing in front of bWalletX users and pay in BSV. v1 is by email: the page says what it costs and how to ask; we
 * answer with a BSV payment request. (No payment address lives in source: it is given in the reply.) Dynamic,
 * in-wallet ads come later.
 */
export const AD_PAGE_URL = 'https://bwalletx.com/advertise';
/** One week in the Store showcase. Small on purpose: the audience is small (beta). Change here only. */
export const AD_PRICE_USD_PER_WEEK = 5;

export const adSlideText = (price = AD_PRICE_USD_PER_WEEK) => ({
  kind: 'Advertise',
  title: 'Your ad here',
  blurb: `For Bitcoin · from $${price} a week`,
});
