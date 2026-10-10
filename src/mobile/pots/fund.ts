import { Hash, Utils } from '@bsv/sdk';
import { SUBSCRIPTIONS_ENABLED } from '../storeBuild';
import { startPotCreate } from '../agents/agentCreate';
import { addSubscription, getPot, listPots, listSubs, servicePayee, type NewSub } from './pots';

/**
 * Back bWalletX (owner, 10 Oct 2026; design page "Back bWalletX and Token Feeds" §1): a pot the user funds now and a
 * dollar-priced monthly subscription from it to the bWalletX development fund. It is support for development, never
 * an investment: nothing comes back but thanks (Supporter badge, credits, early betas). The money stays in the
 * user's own pot until each month's payment; stopping keeps the rest there. bWalletX only (hidden in the store
 * edition by SUBSCRIPTIONS_ENABLED, App Store 3.1.1 / Play payments).
 */
export const FUND_SERVICE = 'bwalletx-fund';
export const FUND_NAME = 'bWalletX development fund';
export const FUND_POT_NAME = 'Back bWalletX';
export const FUND_AMOUNTS = [5, 10, 25] as const;
export const FUND_MONTHS = [3, 6, 12] as const;
export const MAX_FUND_USD = 1000;

/** The fund is offered only where subscriptions are on and the fund's payee is configured. */
export const fundAvailable = () => SUBSCRIPTIONS_ENABLED && !!servicePayee(FUND_SERVICE);

/**
 * Each payment's OP_RETURN reference: `bwalletx-fund:<hash160 of the supporter's identity key>`. It names the
 * supporter's main wallet (not the pot's own keys) so bChatX can show a Supporter badge on the right account
 * without anyone holding a list. It reveals nothing a public identity key doesn't already.
 */
export const fundMemo = (identityPubKeyHex: string): string => {
  const hex = identityPubKeyHex.trim().toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(hex)) throw new Error('No identity key');
  return `${FUND_SERVICE}:${Utils.toHex(Hash.hash160(Utils.toArray(hex, 'hex')))}`;
};

export type FundPlan = { usdPerMonth: number; months: number; setAsideUsd: number; setAsideSats: number | null };

/** What to put in the pot: months × the monthly amount, and its size in sats at today's rate (null without one). */
export const fundPlan = (usdPerMonth: number, months: number, bsvUsd: number): FundPlan => {
  const setAsideUsd = Math.round(usdPerMonth * months * 100) / 100;
  const setAsideSats = bsvUsd > 0 ? Math.ceil((setAsideUsd / bsvUsd) * 1e8) : null;
  return { usdPerMonth, months, setAsideUsd, setAsideSats };
};

export const fundProblem = (usdPerMonth: number, months: number): string | null => {
  if (!Number.isFinite(usdPerMonth) || usdPerMonth < 1) return 'Pick at least $1 a month';
  if (usdPerMonth > MAX_FUND_USD) return `Up to $${MAX_FUND_USD} a month`;
  if (!Number.isInteger(months) || months < 1 || months > 60) return 'Set aside 1–60 months';
  return null;
};

/** The subscription a fund pot gets: monthly, in dollars, starting today, until stopped. */
export const fundSub = (potId: string, usdPerMonth: number, memo: string, now = Date.now()): NewSub => ({
  potId,
  payee: { name: FUND_NAME, service: FUND_SERVICE },
  amount: { value: usdPerMonth, currency: 'USD' },
  period: 'month',
  start: now,
  maxCount: null,
  memo,
});

// ── Creating the pot: Add account makes its keys, then the subscription is attached (agentCreate.ts) ────────

const INTENT = 'bwallet.fundIntent';
type Intent = { usdPerMonth: number; memo: string };

/** Fund sheet › Create pot: remember the plan, then the next account Add account creates becomes the fund pot. */
export const startFundPot = (usdPerMonth: number, identityPubKeyHex: string) => {
  const memo = fundMemo(identityPubKeyHex);
  try {
    localStorage.setItem(INTENT, JSON.stringify({ usdPerMonth, memo } satisfies Intent));
  } catch {
    /* storage unavailable */
  }
  startPotCreate(FUND_POT_NAME, '💛');
};

const takeIntent = (): Intent | null => {
  try {
    const v = localStorage.getItem(INTENT);
    localStorage.removeItem(INTENT);
    const o = v ? (JSON.parse(v) as Partial<Intent>) : null;
    return o && typeof o.usdPerMonth === 'number' && typeof o.memo === 'string'
      ? { usdPerMonth: o.usdPerMonth, memo: o.memo }
      : null;
  } catch {
    return null;
  }
};

/** Right after the fund pot is made: add its monthly subscription. A no-op when no fund plan is waiting. */
export const consumeFundIntent = (potId: string, bsvUsd = 0, now = Date.now()) => {
  const i = takeIntent();
  if (!i || !getPot(potId) || !fundAvailable()) return null;
  if (fundProblem(i.usdPerMonth, 1)) return null;
  return addSubscription(fundSub(potId, i.usdPerMonth, i.memo, now), bsvUsd, now);
};

/** The pot already backing bWalletX (named so, or paying the fund), if any. */
export const existingFundPot = () =>
  listPots().find(
    (p) =>
      p.name === FUND_POT_NAME ||
      listSubs(p.identityAddress).some(
        (s) => s.payee.service === FUND_SERVICE && s.status !== 'cancelled' && s.status !== 'ended',
      ),
  ) ?? null;
