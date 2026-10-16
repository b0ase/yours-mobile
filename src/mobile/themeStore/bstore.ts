/**
 * bStore client data model (docs/BSTORE.md). Listings, subscriptions, the fee split, allowed categories and the
 * prohibited list. Pure data and validation: no network, no payments. The server side (bit-sign listings CRUD,
 * review queue, receipts, renewals) is a spec in docs/BSTORE.md and not built yet.
 */

/** Seller share of every bStore sale (owner decision, 16 Oct 2026). Configurable: change it here only. */
export const SELLER_SHARE = 0.8;
export const feeSplitLabel = (seller = SELLER_SHARE) =>
  `Seller gets ${Math.round(seller * 100)}%, bStore ${Math.round((1 - seller) * 100)}%`;

/** Split a price (USD cents, integer) into seller and bStore parts; the seller gets the rounding. */
export function splitCents(cents: number, seller = SELLER_SHARE): { seller: number; bstore: number } {
  const c = Math.max(0, Math.round(cents));
  const fee = Math.floor((c * (10000 - Math.round(seller * 10000))) / 10000);
  return { seller: c - fee, bstore: fee };
}

export type Period = 'day' | 'week' | 'month';
export type ListingType = 'one-off' | 'subscription';
export type ListingStatus = 'pending' | 'live' | 'removed';

/** Digital goods and services only. */
export const ALLOWED_CATEGORIES = [
  ['themes', 'Themes'],
  ['stickers', 'Sticker & emoji packs'],
  ['art', 'Art & NFT editions'],
  ['media', 'Music & video access'],
  ['learning', 'Courses & ebooks'],
  ['rooms', 'Room memberships'],
  ['services', 'Design & dev services'],
] as const;
export type Category = (typeof ALLOWED_CATEGORIES)[number][0];
const CATEGORY_IDS: readonly string[] = ALLOWED_CATEGORIES.map(([id]) => id);

/** Shown in the sell flow; b rejects any listing in these. */
export const PROHIBITED = [
  'Illegal goods or services',
  'Weapons',
  'Drugs',
  'Adult content',
  'Securities or investment offers (shares, returns, profit share)',
  'Gambling',
  'Counterfeit or stolen goods, or other people’s work',
  'Personal data',
  'Anything that needs KYC',
] as const;

export interface Listing {
  id: string;
  /** Seller paymail or identity key. */
  seller: string;
  category: Category;
  title: string;
  description: string;
  images: string[];
  /** Price in USD cents, settled in BSV at the rate when paid. */
  priceCents: number;
  type: ListingType;
  /** Required when type is 'subscription'. */
  period?: Period;
  perks?: string[];
  status: ListingStatus;
  /** Seeded placeholder, not a real offer. */
  example?: boolean;
}

export const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
export const priceLabel = (l: Pick<Listing, 'priceCents' | 'type' | 'period'>) =>
  l.type === 'subscription' && l.period ? `${usd(l.priceCents)} / ${l.period}` : usd(l.priceCents);

export interface Draft {
  seller: string;
  category: string;
  title: string;
  description: string;
  images: string[];
  price: string;
  type: ListingType;
  period?: Period;
  perks?: string;
}

/** Validate a sell-flow draft. Returns errors (empty when OK) and the listing to submit (status pending). */
export function draftToListing(d: Draft, id: string): { errors: string[]; listing?: Listing } {
  const errors: string[] = [];
  if (!d.seller.trim()) errors.push('Sign in so buyers know who is selling.');
  if (!CATEGORY_IDS.includes(d.category)) errors.push('Pick a category.');
  const title = d.title.trim();
  if (title.length < 3 || title.length > 80) errors.push('Title: 3 to 80 characters.');
  const description = d.description.trim();
  if (description.length < 10 || description.length > 2000) errors.push('Description: 10 to 2000 characters.');
  const n = Number(d.price);
  const priceCents = Math.round(n * 100);
  if (!Number.isFinite(n) || priceCents < 1 || priceCents > 1_000_000) errors.push('Price: $0.01 to $10,000.');
  if (d.type === 'subscription' && !d.period) errors.push('Pick a period for the subscription.');
  if (d.images.length > 6) errors.push('Up to 6 images.');
  if (errors.length) return { errors };
  const perks = (d.perks ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
  return {
    errors,
    listing: {
      id,
      seller: d.seller.trim(),
      category: d.category as Category,
      title,
      description,
      images: d.images,
      priceCents,
      type: d.type,
      ...(d.type === 'subscription' ? { period: d.period, perks } : {}),
      status: 'pending',
    },
  };
}

/** Only live listings are shown to buyers; pending waits for b, removed is gone. */
export const visible = (ls: readonly Listing[]) => ls.filter((l) => l.status === 'live');

/** Seed subscriptions, clearly labelled Example, used only when the server has none. */
export const EXAMPLE_SUBSCRIPTIONS: readonly Listing[] = [
  {
    id: 'ex-b-plus',
    seller: 'bcorp@bwalletx.com',
    category: 'services',
    title: 'b Plus',
    description: 'Bigger b limits: longer answers and more of them each day.',
    images: [],
    priceCents: 500,
    type: 'subscription',
    period: 'month',
    perks: ['Bigger b limits', 'Cancel anytime'],
    status: 'live',
    example: true,
  },
  {
    id: 'ex-room',
    seller: 'a token room owner',
    category: 'rooms',
    title: 'Room membership',
    description: 'Membership of a token room, paid per week instead of holding the token.',
    images: [],
    priceCents: 100,
    type: 'subscription',
    period: 'week',
    perks: ['Read and post in the room', 'Cancel anytime'],
    status: 'live',
    example: true,
  },
  {
    id: 'ex-fan-club',
    seller: 'a creator',
    category: 'media',
    title: 'Creator fan club',
    description: 'Early tracks, behind-the-scenes posts and a fan badge.',
    images: [],
    priceCents: 300,
    type: 'subscription',
    period: 'month',
    perks: ['Early access', 'Fan badge', 'Cancel anytime'],
    status: 'live',
    example: true,
  },
];
