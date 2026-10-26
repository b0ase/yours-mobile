import type { OneSatContext } from '@1sat/actions';
import { checkApprovedPayees, type MessageCharge } from '../chat/roomSpend';
import { GuardedPayError } from '../../services/guardedPay';

/**
 * Paid listening in a Space (bit-sign lib/paid-listening.ts; owner, 11 Oct 2026).
 *
 * The host sets a price per second / minute / hour in BSV (priced in dollars) or a BSV-21 token,
 * paid to the people on stage, to the token's issuer, or burned. A listener approves once with a
 * spending limit for the session; the wallet then pays one minute at a time, straight to the
 * speakers (never through bChatX), and stops at the limit or when they leave.
 *
 * bWalletX only: never in a store build (literal env check so Vite drops the whole module there).
 */
export const PAID_LISTENING_ENABLED: boolean = !(
  import.meta.env.VITE_STORE_BUILD === '1' ||
  import.meta.env.VITE_CHANNEL === 'ios-store' ||
  import.meta.env.VITE_CHANNEL === 'android-play'
);

export type PaidPer = 'second' | 'minute' | 'hour';
export type PaidCurrency = { kind: 'bsv' } | { kind: 'bsv21'; tokenId: string; sym: string; dec: number };
export type PaidDest = 'stage' | 'issuer' | 'burn';

export interface PaidConfig {
  enabled: boolean;
  amount: number;
  per: PaidPer;
  currency: PaidCurrency;
  dest: PaidDest;
  hostSharePct: number;
  freeFirstMinute: boolean;
  issuerAddress?: string;
}

export interface ListenPlan {
  v: 1;
  ticker: string;
  spaceId: string;
  payer: string;
  minute: number;
  body: string;
  rule: 'space-listen';
  charges: MessageCharge[];
  issuedAt: number;
}

export interface PaidState {
  config: PaidConfig | null;
  price: string | null;
  canConfigure: boolean;
  me: { role: string; paidThrough: number | null; hearing: boolean; minutesPaid?: number } | null;
  plan?: ListenPlan;
  sig?: string;
  free?: boolean;
  error?: string;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

export function parsePaidState(data: unknown): PaidState {
  const d = obj(data);
  const c = obj(d.config);
  const cur = obj(c.currency);
  const currency: PaidCurrency | null =
    cur.kind === 'bsv'
      ? { kind: 'bsv' }
      : cur.kind === 'bsv21' && typeof cur.tokenId === 'string'
        ? { kind: 'bsv21', tokenId: cur.tokenId, sym: String(cur.sym ?? ''), dec: Number(cur.dec ?? 0) }
        : null;
  const config: PaidConfig | null =
    currency && typeof c.amount === 'number'
      ? {
          enabled: c.enabled === true,
          amount: c.amount,
          per: c.per === 'second' || c.per === 'hour' ? c.per : 'minute',
          currency,
          dest: c.dest === 'issuer' || c.dest === 'burn' ? c.dest : 'stage',
          hostSharePct: Number(c.hostSharePct ?? 0) || 0,
          freeFirstMinute: c.freeFirstMinute !== false,
          issuerAddress: typeof c.issuerAddress === 'string' ? c.issuerAddress : undefined,
        }
      : null;
  const me = obj(d.me);
  return {
    config,
    price: typeof d.price === 'string' ? d.price : null,
    canConfigure: d.canConfigure === true,
    me: d.me
      ? {
          role: String(me.role ?? 'listener'),
          paidThrough: typeof me.paidThrough === 'number' ? me.paidThrough : null,
          hearing: me.hearing !== false,
          minutesPaid: typeof me.minutesPaid === 'number' ? me.minutesPaid : undefined,
        }
      : null,
    plan: d.plan && typeof d.sig === 'string' ? (d.plan as ListenPlan) : undefined,
    sig: typeof d.sig === 'string' ? d.sig : undefined,
    free: d.free === true,
    error: typeof d.error === 'string' ? d.error : undefined,
  };
}

/**
 * What the listener approved on the sheet (b-Aware, 26 Oct 2026): the unit their limit is in, where the money goes,
 * the payees the sheet named and the session cap. Every later plan is checked against this, never trusted as sent.
 */
export interface ListenApproval {
  currency: PaidCurrency;
  dest: PaidDest;
  payees: readonly string[];
  limit: bigint;
}

const RAW = /^[1-9][0-9]*$/;

/**
 * Check a plan against the approval before anything is signed, and return its total in the limit's unit.
 * Refused (GuardedPayError): no cap; no lines or a line without a positive whole amount (no floor); any line in a
 * unit other than the limit's (sats for BSV, that one token for BSV-21); a burn unless the sheet said burned; any
 * payee the sheet did not name.
 */
export function checkListenPlan(p: ListenPlan, a: ListenApproval): bigint {
  if (!(a.limit > BigInt(0))) throw new GuardedPayError('no spending limit was set for this session');
  if (!Array.isArray(p.charges) || !p.charges.length) throw new GuardedPayError('the plan has nothing to pay');
  let total = BigInt(0);
  for (const c of p.charges) {
    if (typeof c.amount !== 'string' || !RAW.test(c.amount)) throw new GuardedPayError('a plan line has no amount');
    const unitOk =
      a.currency.kind === 'bsv' ? c.unit === 'sats' : c.unit === 'token' && c.tokenId === a.currency.tokenId;
    if (!unitOk) throw new GuardedPayError("a plan line is not in your limit's unit");
    if (c.to === 'burn' && a.dest !== 'burn') throw new GuardedPayError('the plan burns what you agreed to pay');
    if (a.dest === 'burn' && c.to !== 'burn') throw new GuardedPayError('the plan pays out what you agreed to burn');
    total += BigInt(c.amount);
  }
  checkApprovedPayees(p.charges, a.payees);
  return total;
}

/**
 * The approval for the plan shown on the sheet: the issuer the config names (dest issuer), the plan's own payees
 * (dest stage: the people on stage, listed on the sheet), or none (burn). Throws if that plan itself fails the check.
 */
export function approveListen(cfg: PaidConfig, plan: ListenPlan | undefined, limit: bigint): ListenApproval {
  if (!plan) throw new GuardedPayError('there is no price to approve yet');
  const payees =
    cfg.dest === 'burn'
      ? []
      : cfg.dest === 'issuer'
        ? cfg.issuerAddress
          ? [cfg.issuerAddress]
          : []
        : [...new Set(plan.charges.map((c) => c.to).filter((t) => t !== 'burn'))];
  const a: ListenApproval = { currency: cfg.currency, dest: cfg.dest, payees, limit };
  checkListenPlan(plan, a);
  return a;
}

/** Total of a plan, checked against the approval (throws on any unit, floor or payee problem). */
export const planTotal = (p: ListenPlan, a: ListenApproval): bigint => checkListenPlan(p, a);

/**
 * Pay this minute now? Pays shortly before the paid time ends, never past the session limit, and never a plan that
 * fails checkListenPlan ('refuse').
 */
export function shouldPay(o: {
  approval: ListenApproval | null;
  plan: ListenPlan | undefined;
  paidThrough: number | null;
  now: number;
  spent: bigint;
  busy: boolean;
  leadMs?: number;
}): 'pay' | 'wait' | 'limit' | 'refuse' {
  if (!o.approval || !o.plan || o.busy) return 'wait';
  let total: bigint;
  try {
    total = checkListenPlan(o.plan, o.approval);
  } catch {
    return 'refuse';
  }
  const lead = o.leadMs ?? 20_000;
  if (o.paidThrough !== null && o.paidThrough - o.now > lead) return 'wait';
  if (o.spent + total > o.approval.limit) return 'limit';
  return 'pay';
}

/** "$0.04" for sats at a rate, or "12.5 $PNEE" for raw token units. */
export function formatSpent(raw: bigint, currency: PaidCurrency, bsvUsd: number | null): string {
  if (currency.kind === 'bsv') {
    if (!bsvUsd) return `${raw.toString()} sats`;
    return `$${((Number(raw) / 1e8) * bsvUsd).toFixed(2)}`;
  }
  const v = Number(raw) / 10 ** currency.dec;
  return `${v} $${currency.sym || 'tokens'}`;
}

/** The session limit in the payment's own unit, from a dollar (BSV) or token amount the listener chose. */
export function limitRaw(amount: number, currency: PaidCurrency, bsvUsd: number | null): bigint {
  if (!(amount > 0)) return BigInt(0);
  if (currency.kind === 'bsv') return bsvUsd ? BigInt(Math.floor((amount / bsvUsd) * 1e8)) : BigInt(0);
  return BigInt(Math.floor(amount * 10 ** currency.dec));
}

export interface PaidClient {
  spacePaid(ticker: string): Promise<unknown>;
  spacePaidAction(ticker: string, body: Record<string, unknown>): Promise<unknown>;
}

/**
 * Pay one minute: the plan is checked against the listener's approval (payees, unit, floor, cap), then the wallet
 * signs a transaction paying exactly the plan (and committing to this
 * Space and minute); bit-sign checks it, broadcasts it and records it. A refused payment is
 * released so its coins are spendable again.
 */
export async function payPlan(
  ctx: OneSatContext,
  client: PaidClient,
  plan: ListenPlan,
  sig: string,
  approval: ListenApproval,
  deps: {
    payForMessage: (
      ctx: OneSatContext,
      m: {
        ticker: string;
        handle: string;
        text: string;
        charge: { rule: string; charges: MessageCharge[]; unenforced: null; exempt: false };
        approvedPayees: readonly string[];
      },
    ) => Promise<{ beef: string; txid: string }>;
    releasePayment: (ctx: OneSatContext, txid: string, cause: unknown) => Promise<void>;
  },
): Promise<{ txid: string; paidThrough: number | null }> {
  checkListenPlan(plan, approval);
  const signed = await deps.payForMessage(ctx, {
    ticker: plan.ticker,
    handle: plan.payer,
    text: plan.body,
    charge: { rule: plan.rule, charges: plan.charges, unenforced: null, exempt: false },
    approvedPayees: approval.payees,
  });
  try {
    const r = obj(await client.spacePaidAction(plan.ticker, { action: 'pay', plan, sig, beef: signed.beef }));
    return { txid: signed.txid, paidThrough: typeof r.paidThrough === 'number' ? r.paidThrough : null };
  } catch (e) {
    void deps.releasePayment(ctx, signed.txid, e);
    throw e;
  }
}
