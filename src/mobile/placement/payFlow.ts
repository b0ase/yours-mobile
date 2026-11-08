/**
 * bShares Pay never pays twice (audit M5 follow-up, review 8 Nov 2026). Pure apart from the injected store, wallet
 * listing and claim call; tested in payFlow.test.ts and payRetry.test.ts. Only BsharesPage imports it, so it lives in
 * the lazy PLACEMENT_ENABLED chunk and never ships in a store build.
 *
 * The record of a payment is written on this device BEFORE the wallet is asked to pay, the way the Send page notes a
 * recipient before sending (utils/uncertainSends.ts):
 *   pending  { quote_id, memo, memo_script, startedAt }            before createAction
 *            { …, txid, rawtx }                                   once the wallet answered with the payment
 *   failed   { quote_id, txid, rawtx, code, reason }              the server refused the claim
 * A pending record without a txid (the app died, or the wallet said "can't confirm") is looked for in the wallet's
 * own actions by its memo script; when it isn't found, the person is asked before paying again (Cancel first). A
 * failed record never pays: a claim that may succeed later is offered again ("Try the claim again"), one that can't
 * shows the txid to ask the directors for a refund.
 */
import { ChatApiError } from '../chat/api';
import { classifySendError } from '../../utils/sendErrors';
import { STORAGE_MAYBE_SENT_CODE } from '../../services/storageFailover';
import { BSHARES_LABEL } from './actions';
import type { ClaimAnswer, PlacementQuote } from './api';

export type PendingPay = {
  quote_id: string;
  memo: string;
  memo_script: string;
  startedAt: number;
  txid?: string;
  rawtx?: string;
};

export type FailedClaim = { quote_id: string; txid: string; rawtx?: string; code: string; reason: string };

/** localStorage, or anything shaped like it (tests). */
export interface PayStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** This device's localStorage; every call guarded (private mode, storage off). */
export const deviceStore = (): PayStore => ({
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage off: savePending notices */
    }
  },
  remove: (k) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
});

export const pendingKey = (offerId: string) => `bshares-claim:${offerId}`;
export const failedKey = (offerId: string) => `bshares-claim-failed:${offerId}`;

const parse = (raw: string | null): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(raw || 'null') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The pending payment for this offer (records from before 8 Nov 2026 had only quote_id + txid). */
export function readPending(store: PayStore, offerId: string): PendingPay | null {
  const o = parse(store.get(pendingKey(offerId)));
  if (!o || !str(o.quote_id)) return null;
  const p: PendingPay = {
    quote_id: str(o.quote_id),
    memo: str(o.memo),
    memo_script: str(o.memo_script).toLowerCase(),
    startedAt: typeof o.startedAt === 'number' ? o.startedAt : 0,
  };
  if (str(o.txid)) p.txid = str(o.txid).toLowerCase();
  if (str(o.rawtx)) p.rawtx = str(o.rawtx);
  return p;
}

/** Writes the record and reads it back: false when this device can't keep it (then nothing must be paid). */
export function savePending(store: PayStore, offerId: string, p: PendingPay): boolean {
  const v = JSON.stringify(p);
  store.set(pendingKey(offerId), v);
  return store.get(pendingKey(offerId)) === v;
}

/** The refused claim for this offer (records from before 8 Nov 2026 had only txid + reason: never re-claimed). */
export function readFailed(store: PayStore, offerId: string): FailedClaim | null {
  const o = parse(store.get(failedKey(offerId)));
  if (!o || !str(o.txid)) return null;
  const f: FailedClaim = { quote_id: str(o.quote_id), txid: str(o.txid), code: str(o.code), reason: str(o.reason) };
  if (str(o.rawtx)) f.rawtx = str(o.rawtx);
  return f;
}

/**
 * Refusals that may clear up (the server switched off for a deploy, KYC not finished yet, the offer or treasury
 * edited, signed out, a broadcaster that didn't answer): the claim is kept and offered again. Re-claiming never pays.
 */
export const RECLAIM_CODES: ReadonlySet<string> = new Set([
  'not_configured',
  'kyc_required',
  'offer_changed',
  'quote_invalid',
  'offer_closed',
  'unauthenticated',
  'broadcast_failed',
  'excess_choice',
]);
/** Retried with the same payment when the server gives no `retryable` flag (bit-sign INVEST_RETRYABLE + a 500). */
const RETRY_FALLBACK: ReadonlySet<string> = new Set(['not_seen', 'not_confirmed', 'rate_limited', 'internal']);

export const isReclaimable = (code: string) => RECLAIM_CODES.has(code);

type ErrorData = {
  code?: unknown;
  retryable?: unknown;
  refund_due?: unknown;
  payment_pending?: unknown;
  payment_txid?: unknown;
  txid?: unknown;
  quote_id?: unknown;
};
const errorData = (e: unknown): ErrorData | null =>
  ((e instanceof ChatApiError ? e.data : (e as { data?: unknown } | null)?.data) as ErrorData | null) ?? null;

/**
 * The quote route's "a payment for this offer is already waiting for its confirmation" (409 payment_pending, with
 * that payment's txid and quote_id). It is how a second device, or a device that lost its record, learns not to pay.
 */
export function quotePaymentPending(e: unknown): { quote_id: string; txid: string; message: string } | null {
  const d = errorData(e);
  if (str(d?.code) !== 'payment_pending' || !str(d?.txid) || !str(d?.quote_id)) return null;
  return {
    quote_id: str(d?.quote_id),
    txid: str(d?.txid).toLowerCase(),
    message:
      (e instanceof Error && e.message) || `A payment for this offer (${str(d?.txid)}) is waiting. Don't pay again.`,
  };
}

/**
 * Takes the server's waiting payment as this device's pending record, so the button becomes "Check payment" (claims
 * that quote_id + txid; never pays). A rawtx this device already holds for the same txid is kept.
 */
export function adoptServerPending(
  store: PayStore,
  offerId: string,
  p: { quote_id: string; txid: string },
  now: () => number = Date.now,
): void {
  const mine = readPending(store, offerId);
  const rec: PendingPay = {
    quote_id: p.quote_id,
    memo: mine?.memo ?? '',
    memo_script: mine?.memo_script ?? '',
    startedAt: mine?.startedAt || now(),
    txid: p.txid,
  };
  if (mine?.txid === p.txid && mine.rawtx) rec.rawtx = mine.rawtx;
  store.remove(failedKey(offerId));
  savePending(store, offerId, rec);
}

export type ClaimVerdict = { kind: 'retry' | 'reclaim' | 'final' | 'refund'; code: string; reason: string };

/**
 * What a refused claim means. No answer, or no code: retry (the payment may be fine). A refund_due-style code: the
 * payment was recorded for a refund. Then the server's own `retryable` flag, then the codes above.
 */
export function claimVerdict(e: unknown): ClaimVerdict {
  const data = errorData(e);
  const code = str(data?.code);
  const reason = (e instanceof Error && e.message) || code || 'no answer';
  // A late or extra payment is recorded for a refund (bit-sign 409 refund_due, retryable false): final, never pay.
  if (/refund/i.test(code) || data?.refund_due === true) return { kind: 'refund', code, reason };
  // Waiting for a block or the indexer (not_confirmed / not_seen carry payment_pending: true): the same payment later.
  if (!code || data?.payment_pending === true) return { kind: 'retry', code, reason };
  if (data?.retryable === true) return { kind: 'retry', code, reason };
  if (isReclaimable(code)) return { kind: 'reclaim', code, reason };
  if (data?.retryable === false) return { kind: 'final', code, reason };
  return { kind: RETRY_FALLBACK.has(code) ? 'retry' : 'final', code, reason };
}

// ── What the person is told ──────────────────────────────────────────────────────────────────────────────────────

export const REFUND_RECORDED_MESSAGE = 'Your payment was recorded; the directors will refund it.';
export const refundRecorded = (txid: string) => `${REFUND_RECORDED_MESSAGE} Transaction ${txid}. Don't pay again.`;
export const CHECK_FIRST_MESSAGE = 'An earlier payment may have gone out. Check your history before paying again.';
export const CHECK_UNCHECKED_MESSAGE =
  "We couldn't look through your wallet for it, and an earlier payment may have gone out. Check your history before paying again.";
export const MAYBE_SENT_MESSAGE =
  "We can't confirm whether your payment went out. Don't pay again: tap Check payment, and check your History first.";
export const NO_RECORD_MESSAGE =
  "This device couldn't save a record of the payment, so it wasn't started: without one, a retry could pay twice. Nothing was sent.";
export const OTHER_DEVICE_NOTE = "If you already paid on another device, don't pay again: check there first.";

export const paidButUnclaimed = (txid: string, reason: string) =>
  `Your payment was sent but could not be matched to this offer (${reason}). Don't pay again: ask the company's directors to refund transaction ${txid}.`;
export const reclaimMessage = (txid: string, reason: string) =>
  `The claim for your payment was refused for now (${reason}). Don't pay again: your payment is transaction ${txid}. Tap Try the claim again once that's sorted.`;
const retryMessage = (reason: string, button: string) =>
  `${reason} Your payment is saved on this device: tap ${button} again shortly. Don't pay again.`;

// ── Finding a payment the wallet may have made ───────────────────────────────────────────────────────────────────

type ListedAction = { txid: string; status: string; outputs?: { lockingScript?: string }[] };
export type ListActionsFn = (args: {
  labels: string[];
  includeOutputs: boolean;
  includeOutputLockingScripts: boolean;
  limit: number;
  offset: number;
}) => Promise<{ totalActions: number; actions: ListedAction[] }>;

const PAGE = 100;
/** Statuses that never went out (the toolbox already leaves 'failed' out of listActions). */
const NOT_OUT = new Set(['unsigned', 'nosend', 'nonfinal', 'failed']);

/**
 * The wallet's bShares action carrying this memo script (the quote's own OP_RETURN, unique per quote).
 * { found: false } only when the whole list was read; any error → null (couldn't check).
 */
export async function findPaidAction(
  listActions: ListActionsFn,
  memoScript: string,
): Promise<{ found: true; txid: string } | { found: false } | null> {
  const want = memoScript.toLowerCase();
  if (!want) return null;
  try {
    for (let offset = 0; offset < 100_000; offset += PAGE) {
      const r = await listActions({
        labels: [BSHARES_LABEL],
        includeOutputs: true,
        includeOutputLockingScripts: true,
        limit: PAGE,
        offset,
      });
      const hit = r.actions.find(
        (a) => !!a.txid && !NOT_OUT.has(a.status) && a.outputs?.some((o) => o.lockingScript?.toLowerCase() === want),
      );
      if (hit) return { found: true, txid: hit.txid.toLowerCase() };
      if (r.actions.length < PAGE || offset + r.actions.length >= r.totalActions) break;
    }
    return { found: false };
  } catch {
    return null;
  }
}

// ── The flow ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type PayDeps = {
  store: PayStore;
  listActions: ListActionsFn;
  /** The claim call (the page adds the offer id and excessChoice). */
  claim: (c: { quote_id: string; txid: string; rawtx?: string }) => Promise<ClaimAnswer>;
  now?: () => number;
};

export type PayOutcome =
  | { kind: 'claimed' }
  | { kind: 'refund'; message: string; txid: string }
  | { kind: 'retry'; message: string; txid: string }
  | { kind: 'reclaim'; message: string; txid: string }
  | { kind: 'final'; message: string; txid: string }
  /** The wallet's answer leaves the payment's fate open and it isn't in the wallet: kept, never "pay again". */
  | { kind: 'maybe-sent'; message: string }
  /** Proven not sent (or never started): nothing kept, paying again is fine. */
  | { kind: 'not-sent'; message: string }
  /** A payment was started here but can't be found: ask before paying again (Cancel first). */
  | { kind: 'check-first'; message: string };

/** What the Pay area shows for this offer on this device. */
export type PayState =
  | { kind: 'none' }
  | { kind: 'pending'; rec: PendingPay }
  | { kind: 'reclaim'; rec: FailedClaim }
  | { kind: 'final'; rec: FailedClaim };

export function payState(store: PayStore, offerId: string): PayState {
  const f = readFailed(store, offerId);
  if (f) return isReclaimable(f.code) ? { kind: 'reclaim', rec: f } : { kind: 'final', rec: f };
  const p = readPending(store, offerId);
  return p ? { kind: 'pending', rec: p } : { kind: 'none' };
}

/** The button for each state; null = no button (a payment that can only be refunded). */
export const PAY_BUTTON: Record<PayState['kind'], string | null> = {
  none: 'Pay',
  pending: 'Check payment',
  reclaim: 'Try the claim again',
  final: null,
};

async function claimWith(
  d: PayDeps,
  offerId: string,
  rec: { quote_id: string; txid: string; rawtx?: string },
  from: 'pending' | 'failed',
): Promise<PayOutcome> {
  let answer: ClaimAnswer | null;
  try {
    answer = await d.claim({ quote_id: rec.quote_id, txid: rec.txid, ...(rec.rawtx ? { rawtx: rec.rawtx } : {}) });
  } catch (e) {
    const v = claimVerdict(e);
    if (v.kind === 'refund') {
      d.store.remove(pendingKey(offerId));
      d.store.remove(failedKey(offerId));
      const paid = str(errorData(e)?.payment_txid).toLowerCase() || rec.txid;
      return { kind: 'refund', message: refundRecorded(paid), txid: paid };
    }
    // The record stays exactly where it is, so the next tap claims the same payment again.
    if (v.kind === 'retry')
      return {
        kind: 'retry',
        message: retryMessage(v.reason, PAY_BUTTON[from === 'failed' ? 'reclaim' : 'pending']!),
        txid: rec.txid,
      };
    const failed: FailedClaim = { quote_id: rec.quote_id, txid: rec.txid, code: v.code, reason: v.reason };
    if (rec.rawtx) failed.rawtx = rec.rawtx;
    d.store.set(failedKey(offerId), JSON.stringify(failed));
    d.store.remove(pendingKey(offerId));
    return v.kind === 'reclaim'
      ? { kind: 'reclaim', message: reclaimMessage(rec.txid, v.reason), txid: rec.txid }
      : { kind: 'final', message: paidButUnclaimed(rec.txid, v.reason), txid: rec.txid };
  }
  d.store.remove(pendingKey(offerId));
  d.store.remove(failedKey(offerId));
  if (answer?.status === 'refund_due' || answer?.refund_due === true)
    return { kind: 'refund', message: refundRecorded(rec.txid), txid: rec.txid };
  return { kind: 'claimed' };
}

/**
 * The button on an offer with a record ("Check payment" / "Try the claim again"). Never pays: it claims a payment
 * already made, finds one the wallet made, or says to check before paying again. null when nothing is recorded.
 */
export async function checkPayment(d: PayDeps, offerId: string): Promise<PayOutcome | null> {
  const s = payState(d.store, offerId);
  if (s.kind === 'none') return null;
  if (s.kind === 'final')
    return { kind: 'final', message: paidButUnclaimed(s.rec.txid, s.rec.reason), txid: s.rec.txid };
  if (s.kind === 'reclaim') return claimWith(d, offerId, s.rec, 'failed');
  const p = s.rec;
  if (p.txid) return claimWith(d, offerId, { quote_id: p.quote_id, txid: p.txid, rawtx: p.rawtx }, 'pending');
  const found = await findPaidAction(d.listActions, p.memo_script);
  if (found?.found) {
    savePending(d.store, offerId, { ...p, txid: found.txid });
    return claimWith(d, offerId, { quote_id: p.quote_id, txid: found.txid }, 'pending');
  }
  return { kind: 'check-first', message: found === null ? CHECK_UNCHECKED_MESSAGE : CHECK_FIRST_MESSAGE };
}

/** True when an error from createAction leaves open whether the payment went out (17c: anything but proof). */
export function maybeSent(e: unknown): boolean {
  if ((e as { code?: unknown } | null)?.code === STORAGE_MAYBE_SENT_CODE) return true;
  return classifySendError(e, 'send').moneyMoved !== 'no';
}

/**
 * Pays a checked quote and claims it. The pending record is saved first (no record → no payment). If the wallet
 * throws, the payment is looked for by its memo; found → claimed; proven not sent → forgotten; otherwise kept as
 * "maybe sent" (never "failed, pay again").
 */
export async function payAndClaim(
  d: PayDeps,
  offerId: string,
  q: Pick<PlacementQuote, 'quote_id' | 'memo' | 'memo_script'>,
  pay: () => Promise<{ txid: string; rawtx?: string }>,
): Promise<PayOutcome> {
  // Only from nothing recorded, or an unfound earlier attempt the person chose to pay again over: a payment with a
  // txid, or a refused claim, is only ever claimed.
  const s = payState(d.store, offerId);
  if (s.kind === 'reclaim' || s.kind === 'final' || (s.kind === 'pending' && s.rec.txid))
    return (await checkPayment(d, offerId))!;
  const rec: PendingPay = {
    quote_id: q.quote_id,
    memo: q.memo,
    memo_script: q.memo_script.toLowerCase(),
    startedAt: (d.now ?? Date.now)(),
  };
  if (!savePending(d.store, offerId, rec)) {
    d.store.remove(pendingKey(offerId));
    return { kind: 'not-sent', message: NO_RECORD_MESSAGE };
  }
  let paid: { txid: string; rawtx?: string };
  try {
    paid = await pay();
  } catch (e) {
    const found = await findPaidAction(d.listActions, rec.memo_script);
    if (found?.found) {
      savePending(d.store, offerId, { ...rec, txid: found.txid });
      return claimWith(d, offerId, { quote_id: rec.quote_id, txid: found.txid }, 'pending');
    }
    if (!maybeSent(e)) {
      d.store.remove(pendingKey(offerId));
      return { kind: 'not-sent', message: classifySendError(e, 'send').message };
    }
    return { kind: 'maybe-sent', message: MAYBE_SENT_MESSAGE };
  }
  const withTx: PendingPay = { ...rec, txid: paid.txid.toLowerCase() };
  if (paid.rawtx) withTx.rawtx = paid.rawtx;
  // A rawtx too big for this device's storage is dropped, never the txid (the claim can go without it).
  if (!savePending(d.store, offerId, withTx)) savePending(d.store, offerId, { ...withTx, rawtx: undefined });
  return claimWith(d, offerId, { quote_id: rec.quote_id, txid: withTx.txid!, rawtx: withTx.rawtx }, 'pending');
}
