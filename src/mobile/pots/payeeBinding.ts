/**
 * Payee binding for standing orders. A paymail / $name / OpNS payee is resolved when the user approves it, and the
 * destination they saw is pinned on the order: the address it resolved to (Payee.pinnedAddress) and, when the host
 * serves one, its identity key (Payee.pinnedKey). Every automatic payment re-resolves the payee through
 * destinationFor, the same checks as an interactive send, and must match BOTH pins. Anything else is not paid: the
 * order is flagged needsReview and the user approves the new destination with an explicit tap.
 *
 * The address is pinned as well as the key because standing orders pay basic paymail address resolution, where the
 * host serves an address that nothing ties to the key: a host could keep serving the pinned key and swap the address
 * (b-Aware row 73, open since 25 Oct 2026, reported five times).
 *
 * Orders saved before address pinning have no pinnedAddress (legacyPin). They are pinned only when the address that
 * resolves now is the one their last payment went to; otherwise they stop and ask once. An approved app subscription
 * to a paymail (pinOnFirstPay) pins what its first payment pays, since nothing has been paid to compare with yet.
 *
 * A NEW destination (set-up, a review approval, an app subscription's first payment) must also be one the wallet can
 * check: a basic-resolution paymail address is taken only when it is the served identity key's own P2PKH address.
 * Basic paymail has no signed destination, so any other address is one the host alone vouches for and is refused
 * (backlog 21 Nov 2026, rank 1). Typed addresses, raw keys and OpNS owners are not host-served and pass.
 */
import { PublicKey } from '@bsv/sdk';
import { destinationFor, proofRefusal, type Resolved } from '../names/names';
import { checkPaymentOutputs } from '../../utils/guardedSendBsv';
import { confirmPayeeReview, refreshPayeeReview, type Payee, type Subscription } from './pots';

/** The destination could not be verified: don't pay, ask the user to confirm it again. */
export class PayeeReviewError extends Error {
  constructor(
    message: string,
    /** The key the paymail serves now, if any (shown on the review card). */
    public readonly servedKey?: string,
    /** The address the payee resolves to now, if any: what the review card shows and Approve pins. */
    public readonly servedAddress?: string,
    /** An order saved before address pinning, with no approved address to compare with. */
    public readonly legacy = false,
  ) {
    super(message);
    this.name = 'PayeeReviewError';
  }
}

export const PAYEE_KEY_CHANGED =
  'This paymail now points to a different wallet than when you set up this subscription. Not paying it until you confirm the new destination.';
export const PAYEE_KEY_MISSING =
  'This paymail no longer shows the wallet key it had when you set up this subscription. Not paying it until you confirm.';
export const PAYEE_ADDRESS_CHANGED =
  'This paymail now gives a different address than the one you approved. Not paying it until you approve the new destination.';
export const PAYEE_LEGACY_CONFIRM =
  'This subscription was set up before bWalletX remembered the address it pays. Not paying it until you approve where it goes.';
export const PAYEE_UNVERIFIABLE = (paymail: string) =>
  `${paymail} gives an address that nothing ties to its wallet key, so later payments can’t be checked. Subscriptions can’t pay it: use a Bitcoin address instead.`;
export const PAYEE_REVIEW_MOVED =
  'This paymail now gives a different destination than the one shown. Nothing was approved: the new one is shown above. Check it, then approve.';
export const P2P_ONLY = (paymail: string) => `${paymail} only takes P2P payments, which subscriptions can’t send yet`;

/** The review card's headline (b-Aware row 73). */
export const pointsSomewhereNew = (payee: string) =>
  `${payee} now points somewhere new. Approve the new destination to keep paying.`;

/** Short form of an identity key for confirm cards: first 8 and last 6 hex characters. */
export const keyFingerprint = (key: string) => (key.length > 16 ? `${key.slice(0, 8)}…${key.slice(-6)}` : key);

export type PayeeDestination = { address: string; pubkey?: string };

/** The P2PKH address of a served identity key, or undefined when it isn't a valid key. */
const keyAddress = (key: string): string | undefined => {
  try {
    return PublicKey.fromString(key).toAddress();
  } catch {
    return undefined;
  }
};

/**
 * True when `address` came from a paymail host's basic address resolution and is NOT the served key's own address:
 * nothing but the host says it belongs to the payee, so a standing order can't be set up to it. Pure.
 */
export const unverifiableDestination = (r: Pick<Resolved, 'via' | 'pubkey'>, address: string): boolean =>
  r.via === 'paymail-address' && (!r.pubkey || keyAddress(r.pubkey) !== address);

/**
 * Where to pay a resolved paymail payee, or throw. destinationFor first (unbound / bad binding / BRC-169 key change
 * all refuse); then the pinned key and the pinned address must both match unless `ignorePin` (the user is reviewing
 * a new destination). Bad bindings and pin mismatches throw PayeeReviewError; other refusals throw a plain Error.
 */
export const payeeDestination = (
  p: Payee,
  r: Resolved,
  opts: {
    ignorePin?: boolean;
    /** A destination about to be pinned for the first time (set-up, review approval): it must be checkable. */
    fresh?: boolean;
  } = {},
): PayeeDestination => {
  const d = destinationFor(r, 'bsv');
  if (!d.ok) {
    if (r.nameBinding === 'bad' || r.nameBinding === 'changed' || proofRefusal(r))
      throw new PayeeReviewError(d.error, r.pubkey);
    throw new Error(d.error);
  }
  if (r.targetKind !== 'address') throw new Error(P2P_ONLY(p.paymail ?? r.input));
  const served = d.to;
  // A destination pinned now (set-up, review, an app subscription's first payment) must be one the wallet can check.
  const fresh = opts.fresh || (p.pinOnFirstPay && !p.pinnedAddress);
  if (fresh && unverifiableDestination(r, served)) throw new Error(PAYEE_UNVERIFIABLE(p.paymail ?? r.input));
  if (p.pinnedKey && !opts.ignorePin) {
    if (!r.pubkey) throw new PayeeReviewError(PAYEE_KEY_MISSING, undefined, served);
    if (r.pubkey !== p.pinnedKey) throw new PayeeReviewError(PAYEE_KEY_CHANGED, r.pubkey, served);
  }
  // The key alone proves nothing about a basic-resolution address: the address is pinned too.
  if (p.pinnedAddress && !opts.ignorePin && served !== p.pinnedAddress)
    throw new PayeeReviewError(PAYEE_ADDRESS_CHANGED, r.pubkey, served);
  return { address: served, ...(r.pubkey ? { pubkey: r.pubkey } : {}) };
};

type ResolveFresh = (p: Payee, opts: { ignorePin?: boolean; fresh?: boolean }) => Promise<PayeeDestination>;

/** The payee serves something other than the review card showed. `dest` passed the set-up checks: the card shows it. */
export class PayeeReviewMovedError extends Error {
  constructor(public readonly dest: PayeeDestination) {
    super(PAYEE_REVIEW_MOVED);
    this.name = 'PayeeReviewMovedError';
  }
}

/**
 * The destination a review card's Approve tap may pin, or throw: the payee is looked up again with the set-up checks
 * (fresh), and when the card showed a destination the answer must be exactly that one (else PayeeReviewMovedError).
 * Approve never pins anything the user wasn't shown, nor an address nothing ties to the payee's key.
 */
export const reviewApproval = async (
  s: Pick<Subscription, 'payee' | 'needsReview'>,
  resolve: ResolveFresh,
): Promise<PayeeDestination> => {
  const d = await resolve(s.payee, { ignorePin: true, fresh: true });
  const shown = s.needsReview?.servedAddress;
  if (shown && (d.address !== shown || d.pubkey !== s.needsReview?.servedKey)) throw new PayeeReviewMovedError(d);
  return d;
};

/**
 * The review card's Approve (or Check) tap. Pins the destination when the card showed it, or when `ask` (the confirm
 * showing it) says yes; returns whether it pinned. When the payee has moved on since the card was raised (payDue
 * never looks a payee up again while it waits for review), nothing is pinned: the card is updated to show the new
 * destination, which passed the same set-up checks (a basic paymail address only when it is the served key's own),
 * and the error is rethrown so the user checks it before tapping again. Any other refusal leaves the card as it was.
 */
export const approveReview = async (
  s: Pick<Subscription, 'id' | 'payee' | 'needsReview'>,
  resolve: ResolveFresh,
  ask: (d: PayeeDestination) => boolean,
): Promise<boolean> => {
  let d: PayeeDestination;
  try {
    d = await reviewApproval(s, resolve);
  } catch (e) {
    if (e instanceof PayeeReviewMovedError) refreshPayeeReview(s.id, e.dest);
    throw e;
  }
  if (!s.needsReview?.servedAddress && !ask(d)) return false;
  confirmPayeeReview(s.id, d);
  return true;
};

/**
 * The pins a resolved payee without a pinned address takes before its next automatic payment, or throw
 * PayeeReviewError (asked once: payDue stops the order until the user approves).
 *
 * - An approved app subscription to a paymail that has never paid (pinOnFirstPay): pin what it pays now.
 * - An order saved before address pinning: pin only when the address is the one its last payment went to (and the
 *   key, if one was pinned, still matches: payeeDestination checked that). With no recorded last address, ask.
 *
 * Never pins a destination that differs from one already paid or approved.
 */
export const legacyPin = (
  s: Pick<Subscription, 'payee' | 'paidCount' | 'lastReceipt'>,
  dest: PayeeDestination,
): Pick<Payee, 'pinnedAddress' | 'pinnedKey'> => {
  const pins = {
    pinnedAddress: dest.address,
    ...(s.payee.pinnedKey || dest.pubkey ? { pinnedKey: s.payee.pinnedKey ?? dest.pubkey } : {}),
  };
  if (s.payee.pinOnFirstPay && !s.paidCount && !s.lastReceipt) return pins;
  const last = s.lastReceipt?.to;
  if (last && last === dest.address) return pins;
  throw new PayeeReviewError(last ? PAYEE_ADDRESS_CHANGED : PAYEE_LEGACY_CONFIRM, dest.pubkey, dest.address, !last);
};

/**
 * The outputs a scheduled payment is about to sign must pay `address` exactly `count` × `perPeriod` and nothing
 * else: the check one-off paymail sends run on host outputs (guardedSendBsv.checkPaymentOutputs, 5.2.41), applied
 * to the pinned destination. Returns null when they match, otherwise why not. Pure.
 */
export const scheduledOutputsRefusal = (
  outputs: readonly { address: string; amount: number }[],
  address: string,
  perPeriod: number,
  count: number,
): string | null => {
  if (!address) return 'Payment refused: no destination. Nothing was sent.';
  if (!Number.isSafeInteger(count) || count < 1) return 'Payment refused: no periods to pay. Nothing was sent.';
  const why = checkPaymentOutputs(
    [{ paymail: address, satoshis: perPeriod * count }],
    outputs.map((o) => ({ satoshis: o.amount, outputDescription: `Paymail payment to ${o.address}` })),
  );
  return why ? `Payment refused: ${why}. Nothing was sent.` : null;
};
