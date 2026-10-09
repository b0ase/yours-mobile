/**
 * bMail routing and ranking (pure). Owner, 9 Oct 2026: "Penny post": the default price to reach anyone is 1¢.
 * Friends write free and sit on top; strangers who paid at least my price land in Inbox ranked by verified
 * postage, highest first; everything else (unstamped, under-priced, unverified, airdrops) goes to Requests.
 */

export const PENNY_POST_USD = 0.01;
/** Postage tiers as multiples of the recipient's price (owner, 9 Oct). */
export const TIERS = [
  { id: 'standard', label: 'Standard', mult: 1 },
  { id: 'priority', label: 'Priority', mult: 3 },
  // TODO(bmail receipts): Certified = price + receipt fee, needs signed open receipts (BMAIL.md §5.2).
] as const;
export type TierId = (typeof TIERS)[number]['id'];

export type MailMeta = {
  id: string;
  from: string;
  at: number;
  /** Postage verified on receipt (0 = unstamped or failed verification). */
  verifiedSats: number;
  /** A reply that uses a reply-paid credit I prepaid: counts as stamped. */
  replyCredit?: boolean;
};

export type Box = 'inbox' | 'requests';

export const route = (m: MailMeta, o: { isFriend: (key: string) => boolean; priceSats: number }): Box => {
  if (o.isFriend(m.from) || m.replyCredit) return 'inbox';
  if (m.verifiedSats > 0 && m.verifiedSats >= o.priceSats) return 'inbox';
  return 'requests';
};

/** Friends first (newest first among them), then by verified postage highest first, ties newest. */
export const rank = <T extends MailMeta>(mail: T[], o: { isFriend: (key: string) => boolean; newest?: boolean }): T[] =>
  [...mail].sort((a, b) => {
    if (o.newest) return b.at - a.at;
    const fa = o.isFriend(a.from) || !!a.replyCredit ? 1 : 0;
    const fb = o.isFriend(b.from) || !!b.replyCredit ? 1 : 0;
    if (fa !== fb) return fb - fa;
    if (!fa && a.verifiedSats !== b.verifiedSats) return b.verifiedSats - a.verifiedSats;
    return b.at - a.at;
  });

export const split = <T extends MailMeta>(
  mail: T[],
  o: { isFriend: (key: string) => boolean; priceSats: number; newest?: boolean },
): { inbox: T[]; requests: T[] } => {
  const inbox: T[] = [];
  const requests: T[] = [];
  for (const m of mail) (route(m, o) === 'inbox' ? inbox : requests).push(m);
  return { inbox: rank(inbox, o), requests: rank(requests, o) };
};

/** The sender's quote: tier sats from the recipient's price, plus optional reply-paid credit (my own price). */
export const quote = (priceSats: number, tier: TierId, replyPaidSats = 0) => {
  const mult = TIERS.find((t) => t.id === tier)?.mult ?? 1;
  const stamp = Math.max(1, Math.ceil(priceSats * mult));
  return { stamp, replyPaid: replyPaidSats, total: stamp + replyPaidSats };
};

/** Weighting controls on Inbox / Requests (owner, 9 Oct: "any filters for weighting?"). */
export type SortMode = 'paid' | 'newest' | 'friends' | 'spreading';
export type MailFilter = 'all' | 'paid' | 'tokens' | 'contracts' | 'invoices' | 'receipts';
export const FILTERS: { id: MailFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'paid', label: 'Paid' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'contracts', label: 'Contracts' },
  { id: 'invoices', label: 'Invoices' },
  { id: 'receipts', label: 'Receipts' },
];

/** Friends and reply-paid replies: free, and always pinned on top of the Inbox (owner rule). */
export const isPinned = (m: MailMeta, isFriend: (key: string) => boolean): boolean =>
  isFriend(m.from) || !!m.replyCredit;

/**
 * Sort real mail. Friends (and reply-paid replies) are always pinned in a group on top, newest first; the rest follow by
 * the chosen sort. Most paid = verified postage highest first (ties newest); Newest = time only. "Friends" is a filter:
 * only pinned mail. Spreading needs token holder/forward counts real mail does not carry yet, so it falls back to
 * newest. TODO(bmail tokens): rank by holders/forwards once envelopes carry token outputs.
 */
export const sortMail = <T extends MailMeta>(mail: T[], mode: SortMode, isFriend: (key: string) => boolean): T[] => {
  const pinned = mail.filter((m) => isPinned(m, isFriend)).sort((a, b) => b.at - a.at);
  if (mode === 'friends') return pinned;
  const rest = mail.filter((m) => !isPinned(m, isFriend));
  rest.sort(mode === 'paid' ? (a, b) => b.verifiedSats - a.verifiedSats || b.at - a.at : (a, b) => b.at - a.at);
  return [...pinned, ...rest];
};

/**
 * Filter real mail. Only "Paid" can be told from the envelope today; tokens, contracts, invoices and receipts are not
 * parsed from real mail yet, so those filters show nothing real. TODO(bmail tokens/docs): envelope fields for these.
 */
export const filterMail = <T extends MailMeta>(mail: T[], f: MailFilter): T[] =>
  f === 'all' ? mail : f === 'paid' ? mail.filter((m) => m.verifiedSats > 0 || !!m.replyCredit) : [];
