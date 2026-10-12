/**
 * Network fees on us (owner, 12 Oct 2026; docs/FEE-POT.md). Pure rules, no network, no keys.
 *
 * A fee-payer service (bMusic server, /api/feepot/*) adds ONE funded input and its own change output to an action
 * the user already approved, so the user's wallet spends nothing on the network fee. The user signs their own
 * inputs and keeps their keys; the service signs only its own input. It pays fees only, never the value sent.
 * The server mirrors these numbers and is the authority; the wallet uses them to know when to ask.
 *
 * Off until FEE_POT_ENABLED (VITE_FEE_POT=1, never in a store build) and until the owner funds the pot.
 */

export const FEE_POT_KINDS = [
  'post',
  'like',
  'message',
  'room-join',
  'handle-claim',
  'bpics-mint',
  'artist-play',
] as const;
export type FeePotKind = (typeof FEE_POT_KINDS)[number];

/** New users get their first 30 days of everyday actions on us. Artist sponsorship plays are always covered. */
export const NEW_USER_DAYS = 30;
/** Per user per UTC day. */
export const MAX_ACTIONS_PER_USER_DAY = 200;
/** Most one action's fee may be (sats): a big transaction is the user's to pay. */
export const MAX_FEE_SATS_PER_ACTION = 500;
/** Monthly budget in US dollars (server env FEE_POT_MONTHLY_USD), converted to sats at reserve time. */
export const DEFAULT_MONTHLY_BUDGET_USD = 10;
/**
 * Hard ceiling in sats whatever the price says (server env FEE_POT_MAX_MONTHLY_SATS): 100,000,000 sats = 1 BSV
 * (≈ $20 at $20/BSV), so a bad or crashed price feed can never spend more than this in a month.
 */
export const DEFAULT_MAX_MONTHLY_SATS = 100_000_000;

/**
 * This month's budget in sats: `usd` at `usdPerBsv`, never above `ceilingSats`. No usable price = 0 (the pot pays
 * nothing rather than guess). $10 at $20/BSV = 50,000,000 sats.
 */
export const monthlyBudgetSats = (
  usd = DEFAULT_MONTHLY_BUDGET_USD,
  usdPerBsv: number,
  ceilingSats = DEFAULT_MAX_MONTHLY_SATS,
): number => {
  if (!(usdPerBsv > 0) || !(usd > 0) || !Number.isFinite(usdPerBsv)) return 0;
  return Math.min(Math.max(0, Math.floor(ceilingSats)), Math.floor((usd / usdPerBsv) * 1e8));
};
/** Network fee rate the service pays at (sat per kB). */
export const FEE_RATE_SAT_PER_KB = 100;
/** Bytes the service's own input and change output add (P2PKH in + out). */
export const SPONSOR_OVERHEAD_BYTES = 148 + 34;

export type FeePotUsage = {
  /** Actions this user has had covered today (UTC). */
  userToday: number;
  /** Sats spent from the pot this calendar month (all users). */
  monthSats: number;
};

export type FeePotRequest = {
  kind: string;
  /** When the user's account was first seen. */
  userCreatedAt: Date;
  now: Date;
  /** Size of the signed transaction without the service's input and change, in bytes. */
  txBytes: number;
};

export type FeePotDecision =
  | { ok: true; feeSats: number }
  | { ok: false; reason: 'kind' | 'not-new' | 'user-day' | 'too-big' | 'month-budget' };

/** Network fee for `bytes` at `rate` sat/kB, rounded up, at least 1 sat. */
export const feeFor = (bytes: number, rate = FEE_RATE_SAT_PER_KB) =>
  Math.max(1, Math.ceil((Math.max(0, bytes) * rate) / 1000));

const isKind = (k: string): k is FeePotKind => (FEE_POT_KINDS as readonly string[]).includes(k);

/** Will the pot pay this action's network fee? All caps are checked before anything is signed. */
export function feePotDecision(req: FeePotRequest, usage: FeePotUsage, budgetSats: number): FeePotDecision {
  if (!isKind(req.kind)) return { ok: false, reason: 'kind' };
  const ageDays = (req.now.getTime() - req.userCreatedAt.getTime()) / 86_400_000;
  if (req.kind !== 'artist-play' && !(ageDays >= 0 && ageDays < NEW_USER_DAYS)) return { ok: false, reason: 'not-new' };
  if (usage.userToday >= MAX_ACTIONS_PER_USER_DAY) return { ok: false, reason: 'user-day' };
  const feeSats = feeFor(req.txBytes + SPONSOR_OVERHEAD_BYTES);
  if (feeSats > MAX_FEE_SATS_PER_ACTION) return { ok: false, reason: 'too-big' };
  if (usage.monthSats + feeSats > budgetSats) return { ok: false, reason: 'month-budget' };
  return { ok: true, feeSats };
}

/**
 * The check the service makes before it signs: its input pays only the fee. `sponsorIn` is its input's value,
 * `sponsorChange` its change output. The difference must be no more than the agreed fee (never the value sent).
 */
export const contributionOk = (sponsorIn: number, sponsorChange: number, agreedFeeSats: number) =>
  Number.isInteger(sponsorIn) &&
  Number.isInteger(sponsorChange) &&
  sponsorChange >= 0 &&
  sponsorIn - sponsorChange >= 0 &&
  sponsorIn - sponsorChange <= agreedFeeSats &&
  agreedFeeSats <= MAX_FEE_SATS_PER_ACTION;
