// bShares: the bCorp share placement domain (docs/BCORP-PLACEMENT.md). Pure: no network, no keys.
// Tranche size, price and BSV rate are entered by the director in the UI. Nothing here is a cap-table number;
// shares in issue and holders always come from bit-sign's register.
import { excessRefundDue, type ExcessChoice } from './minute';

/** The company bShares serves (owner decision 14 Oct 2026). bit-sign stores room tickers upper-case without '$'. */
export const BSHARES_TICKER = 'bcorp';
/** "$bcorp" — how the ticker is shown. */
export const tickerLabel = (t: string = BSHARES_TICKER) => `$${t.replace(/^\$/, '').toLowerCase()}`;

export type OfferStatus =
  | 'offered' // director created it for a named member
  | 'accepted' // investor accepted and gave their share-lock key
  | 'paid' // investor's BSV reached the treasury multisig (txid verified by bit-sign)
  | 'approved' // director approved the allotment (board approval recorded); register written
  | 'issued' // $403 token locked 2-of-2 / timelock is in the investor's wallet
  | 'refund_due' // paid but not approved (declined or expired): treasury owes the BSV back
  | 'refunded'
  | 'withdrawn' // director withdrew before payment
  | 'expired'; // nobody paid before expires_at

export type PlacementOffer = {
  id: string;
  ticker: string;
  investorHandle: string;
  shares: number;
  /** Price per share in pence (GBP), entered by the director. */
  pricePence: number;
  /** £ per BSV, in pence, fixed by the director on the day of the offer. */
  gbpPerBsvPence: number;
  rateDate: string;
  lockMonths: number;
  sats: number;
  status: OfferStatus;
  expiresAt: string;
  investorPubKey?: string;
  directorPubKey?: string;
  paymentTxid?: string;
  unlockHeight?: number;
  tokenOutpoint?: string;
  refundTxid?: string;
  boardMinute?: string;
  /** The minute text generated from the allotment (BCORP-BM-… format), stored with it. */
  boardMinuteText?: string;
  /** Investor's choice for any overpayment, made at payment time. */
  excessChoice?: ExcessChoice;
  /** What actually reached the treasury, and how much of it was above `sats`. */
  paidSats?: number;
  excessSats?: number;
  /** Treasury refund of an excess the investor asked back (pending director action until set). */
  excessRefundTxid?: string;
  /** Directors only: the member's holding on the register before this allotment (for the minute preview). */
  holdingBefore?: number;
  events: { at: string; by: string; kind: string; note?: string }[];
};

export type Holding = {
  shares: number;
  shareClass: string;
  /** Present when the holding is backed by a locked $403 token. */
  token?: { outpoint: string; unlockHeight: number; directorPubKey: string };
};

export type Company = {
  /** The company's bChatX room id (the room is the company). */
  id?: string;
  ticker: string;
  name: string;
  /** From the register (sum of the class's shares in issue). Never hardcoded. */
  sharesInIssue: number;
  /** Authorised ceiling from the articles (bit-sign config), null when none. */
  authorised?: number | null;
  /** Nominal value per share in nano-pounds, from the register's share class. */
  nominalNanoPounds?: number;
  /** Company number at Companies House, for the minute. */
  companyNumber?: string;
  treasury: { m: number; n: number; lockingScriptHex: string } | null;
  incorporated?: boolean;
  jurisdiction?: string;
  treasuryM?: number;
  shareClasses?: { id: string; name: string; nominalNanoPounds: number; authorised?: number; sharesInIssue: number }[];
};

export type BsharesMe = {
  company: Company;
  role: 'director' | 'member' | null;
  /** The signed-in handle, as bit-sign resolved it. */
  viewer?: string;
  holdings: Holding[];
  offers: PlacementOffer[];
  /** Directors only: the board, and whether each director has contributed keys. */
  board?: { id: string; handle: string; name: string; office: string; hasKeys: boolean }[];
};

/** Who may open bShares: a registered member (holds shares on the register) or a serving director. */
export const mayOpenBshares = (me: Pick<BsharesMe, 'role'> | null): boolean =>
  me?.role === 'director' || me?.role === 'member';

/** BSV owed for a tranche, rounded up to the satoshi: shares × £price ÷ (£/BSV). Integer maths only. */
export function satsFor(shares: number, pricePence: number, gbpPerBsvPence: number): number {
  for (const [k, v] of Object.entries({ shares, pricePence, gbpPerBsvPence }))
    if (!Number.isSafeInteger(v) || v <= 0) throw new Error(`${k} must be a positive whole number`);
  const num = BigInt(shares) * BigInt(pricePence) * 100_000_000n;
  const den = BigInt(gbpPerBsvPence);
  const sats = (num + den - 1n) / den;
  if (sats > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('amount too large');
  return Number(sats);
}

/** "£0.05" from 5 pence; fractional pence not supported (price is entered in whole pence). */
export const pounds = (pence: number) =>
  `£${(pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const bsv = (sats: number) => `${(sats / 1e8).toLocaleString('en-GB', { maximumFractionDigits: 8 })} BSV`;

/** What the investor or director can do next, per status. */
export function nextStep(
  o: Pick<PlacementOffer, 'status'> & Partial<Pick<PlacementOffer, 'excessChoice' | 'excessSats' | 'excessRefundTxid'>>,
  role: 'director' | 'investor',
): string | null {
  const s = o.status;
  if (role === 'investor') {
    if (s === 'offered') return 'Accept';
    if (s === 'accepted') return 'Pay';
    return null;
  }
  if (s === 'paid') return 'Approve allotment';
  if ((s === 'approved' || s === 'issued') && excessRefundDue(o)) return 'Refund excess';
  if (s === 'approved') return 'Issue share token';
  if (s === 'refund_due') return 'Record refund';
  if (s === 'offered' || s === 'accepted') return 'Withdraw';
  return null;
}

export const STATUS_LABEL: Record<OfferStatus, string> = {
  offered: 'Offered',
  accepted: 'Accepted · awaiting payment',
  paid: 'Paid · awaiting director approval',
  approved: 'Allotted · token to issue',
  issued: 'Issued',
  refund_due: 'Refund due',
  refunded: 'Refunded',
  withdrawn: 'Withdrawn',
  expired: 'Expired',
};

/** BRC-43 protocol for the investor's and director's share-lock keys (seed-derived, recoverable). */
export const SHARE_LOCK_PROTOCOL: [2, string] = [2, 'bshares lock'];
/** keyID: the offer id, so each tranche has its own key and recovery needs only the seed + offer id. */
export const shareLockKeyId = (offerId: string) => `offer ${offerId}`;
