/**
 * The tiny, dependency-free part of `window.CWI.theme.offer` (services/themeOfferSite.ts, docs/SITE-THEMES.md
 * "Offer from the page"). Page scripts (cwi.ts) and the content script import this, never the theme code.
 */
export const THEME_OFFER_ACTION = 'bwxThemeOffer';
export const isThemeOfferAction = (type: unknown): boolean => type === THEME_OFFER_ACTION;
