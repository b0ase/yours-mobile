import premiumList from './premiumNames.json';

/**
 * Name Store prices (owner-approved 13 Oct 2026). One rule for everyone, by length, in USD; converted to sats
 * at the live rate when the name is listed or bought. Every place that prices a name reads this module:
 * the Name Store (/names), bMint › OpNS names "List selected" and the auto-list after a mint.
 *
 *   5+ characters  $1
 *   1–4 characters and the owner's premium shortlist: not sold at a tier price ("Make an offer").
 *   Short names (3–4) are held for yearly renting (owner, 22 Oct 2026); until renting ships they are offer-only.
 */
export const NAME_TIERS: readonly { minLength: number; usd: number; label: string }[] = [
  { minLength: 5, usd: 1, label: '5+ characters' },
];


/** Where "Make an offer" goes when there is no chat to open. */
export const OFFER_EMAIL = 'support@bwalletx.com';

const PREMIUM: ReadonlySet<string> = new Set(premiumList as string[]);

const clean = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/^[@$]+/, '');

/** 3–4 character names: held for yearly renting, offers only for now. */
export const isShortName = (name: string): boolean => {
  const len = clean(name).length;
  return len >= 3 && len <= 4;
};

/** On the owner's premium shortlist (or shorter than every tier): offers only, never auto-listed. */
export const isPremiumName = (name: string): boolean => {
  const n = clean(name);
  return PREMIUM.has(n) || n.length < NAME_TIERS[NAME_TIERS.length - 1].minLength;
};

/** Tier price in USD for a name by length alone (ignores the premium list). */
export const lengthTierUsd = (name: string): number => {
  const len = clean(name).length;
  return NAME_TIERS.find((t) => len >= t.minLength)?.usd ?? NAME_TIERS[NAME_TIERS.length - 1].usd;
};

/** The price a name is sold for, in USD, or null for a premium name (make an offer). */
export const nameTierUsd = (name: string): number | null => (isPremiumName(name) ? null : lengthTierUsd(name));

/** "Make an offer" link: a prefilled email to support. */
export const offerHref = (name: string) =>
  `mailto:${OFFER_EMAIL}?subject=${encodeURIComponent(`Offer for the name ${clean(name)}`)}&body=${encodeURIComponent(
    `Hi, I'd like to make an offer for "${clean(name)}".\n\nMy offer: $\nMy $handle or paymail: `,
  )}`;
