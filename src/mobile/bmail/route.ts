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
