/**
 * bShares Pay never pays twice (audit M5 follow-up; reviews of 8 Nov 2026). Pure apart from the injected store, wallet
 * listing and claim call; tested in payFlow.test.ts, payFlowRace.test.ts and payRetry.test.ts. Only BsharesPage
 * imports it, so it lives in the lazy PLACEMENT_ENABLED chunk and never ships in a store build.
 *
 * The record of a payment is written on this device BEFORE the wallet is asked to pay, the way the Send page notes a
 * recipient before sending (utils/uncertainSends.ts). One record per offer, the latest attempt at the top level and
 * every earlier attempt kept in `earlier` (so "Pay again anyway" never loses the first attempt's memo):
 *   pending  { quote_id, memo, memo_script, startedAt, earlier? }  before createAction
 *            { …, txid, rawtx? }                                  once the wallet answered with the payment
 *   failed   { quote_id, txid, code, reason, tries, rawtx? }       the server refused the claim, or holds the payment
 * Every write is read back. Paying is compare-and-set: it goes ahead only over the exact state the confirm sheet was
 * opened over (nothing, or the very attempt it warned about), so a second tab or window can't start a second payment.
 * An attempt without a txid is looked for in the wallet's own actions by its memo script (all attempts); when none is
 * found, the person is asked before paying again (Cancel first). A failed record never pays.
 */
import { ChatApiError } from '../chat/api';
import { classifySendError } from '../../utils/sendErrors';
import { STORAGE_MAYBE_SENT_CODE } from '../../services/storageFailover';
import { BSHARES_LABEL, BSHARES_MEMO_PREFIX } from './actions';
import type { ClaimAnswer, PlacementQuote } from './api';

/** One payment attempt: the quote it paid, and the payment once the wallet answered. */
export type Attempt = {
  quote_id: string;
  memo: string;
  memo_script: string;
  startedAt: number;
  txid?: string;
  rawtx?: string;
  /** bit-sign told us about it (quote 409 payment_pending): verified there, maybe not in this wallet. */
  fromServer?: boolean;
  /** Found in this wallet with no record and no quote (Pay's scan): never claimable, only a warning. */
  orphan?: boolean;
  /** "Search my wallet again" found this wallet no longer has it as sent (failed / abandoned). */
  abandoned?: boolean;
  /** First time the claim said the network can't see the txid (not_seen). */
  notSeenSince?: number;
  /** Found in the wallet after another attempt was claimed: a second payment, for the directors to refund. */
  extra?: boolean;
};
/** The stored pending record: the latest attempt, plus the earlier ones. */
export type PendingPay = Attempt & { earlier?: Attempt[] };

export type FailedClaim = {
  quote_id: string;
  txid: string;
  code: string;
  reason: string;
  tries: number;
  rawtx?: string;
};

/** localStorage, or anything shaped like it (tests). */
export interface PayStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  /** Every key (to find this device's records for other offers); optional. */
  keys?(): string[];
}

/** This device's localStorage; every call guarded (private mode, storage off, quota). Writes are read back. */
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
      /* storage off or full: the read-back notices */
    }
  },
  remove: (k) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
  keys: () => {
    try {
      return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? '').filter(Boolean);
    } catch {
      return [];
    }
  },
});

export const pendingKey = (offerId: string) => `bshares-claim:${offerId}`;
export const failedKey = (offerId: string) => `bshares-claim-failed:${offerId}`;
/** Set once a claim for this offer succeeded: no sheet may pay for it again from this device (stale sheets). */
export const claimedKey = (offerId: string) => `bshares-claimed:${offerId}`;

/** The txid a claim for this offer succeeded with on this device, or null. */
export function readClaimed(store: PayStore, offerId: string): string | null {
  const o = parse(store.get(claimedKey(offerId)));
  return o && str(o.txid) ? str(o.txid).toLowerCase() : null;
}

/** A stored rawtx/BEEF above this many characters is left out (the claim works without it; review #6). */
export const RAWTX_STORE_MAX = 150_000;
/** bit-sign's dead rule: a txid the network still can't see after an hour is treated as maybe never sent. */
export const NOT_SEEN_DEAD_MS = 60 * 60_000;
/** quote_invalid this many times in a row: ask the directors (the claim stays possible, paying never is). */
export const QUOTE_INVALID_ASK_AFTER = 3;
/** A quote older than this (bit-sign's TTL is 10 minutes) is fetched again before the sheet is shown or confirmed. */
export const QUOTE_MAX_AGE_MS = 8 * 60_000;
const ageOk = (from: number, to: number) => to - from >= 0 && to - from <= QUOTE_MAX_AGE_MS;
/**
 * Too old when EITHER clock says over 8 minutes, or either ran backwards: performance.now() can't be fooled by a
 * changed device clock, Date.now() keeps counting while the device sleeps (performance.now() may pause).
 */
export const quoteTooOld = (fetched: { mono: number; wall: number }, now: { mono: number; wall: number }) =>
  !(ageOk(fetched.mono, now.mono) && ageOk(fetched.wall, now.wall));
/** Both clocks, now. */
export const clocksNow = () => ({
  mono: typeof performance !== 'undefined' ? performance.now() : Date.now(),
  wall: Date.now(),
});

const parse = (raw: string | null): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(raw || 'null') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function toAttempt(o: Record<string, unknown>): Attempt | null {
  const a: Attempt = {
    quote_id: str(o.quote_id),
    memo: str(o.memo),
    memo_script: str(o.memo_script).toLowerCase(),
    startedAt: num(o.startedAt),
  };
  if (str(o.txid)) a.txid = str(o.txid).toLowerCase();
  if (str(o.rawtx)) a.rawtx = str(o.rawtx);
  if (o.fromServer === true) a.fromServer = true;
  if (o.orphan === true) a.orphan = true;
  if (o.abandoned === true) a.abandoned = true;
  if (o.extra === true) a.extra = true;
  if (num(o.notSeenSince)) a.notSeenSince = num(o.notSeenSince);
  // Something to claim (quote) or to look for (memo / txid); a record from before 8 Nov had quote_id + txid only.
  return a.quote_id || a.txid ? a : null;
}

/** Every attempt for this offer, oldest first (the last is the latest). Empty when nothing is recorded. */
export function readAttempts(store: PayStore, offerId: string): Attempt[] {
  const o = parse(store.get(pendingKey(offerId)));
  if (!o) return [];
  const latest = toAttempt(o);
  const earlier = Array.isArray(o.earlier)
    ? (o.earlier as unknown[]).map((e) => (e && typeof e === 'object' ? toAttempt(e as Record<string, unknown>) : null))
    : [];
  return [...earlier.filter((a): a is Attempt => !!a), ...(latest ? [latest] : [])];
}

/** The latest attempt (what the card shows), or null. */
export function readPending(store: PayStore, offerId: string): PendingPay | null {
  const all = readAttempts(store, offerId);
  if (!all.length) return null;
  const latest: PendingPay = { ...all[all.length - 1] };
  if (all.length > 1) latest.earlier = all.slice(0, -1);
  return latest;
}

/** Writes the attempts (none → removed) and reads them back: false when this device didn't keep them. */
export function writeAttempts(store: PayStore, offerId: string, attempts: Attempt[]): boolean {
  if (!attempts.length) {
    store.remove(pendingKey(offerId));
    return store.get(pendingKey(offerId)) === null;
  }
  const rec: PendingPay = { ...attempts[attempts.length - 1] };
  if (attempts.length > 1) rec.earlier = attempts.slice(0, -1);
  const v = JSON.stringify(rec);
  store.set(pendingKey(offerId), v);
  return store.get(pendingKey(offerId)) === v;
}

/**
 * Changes ONE attempt (found by quote_id, or by txid for an orphan), leaving every other attempt, including another
 * tab's, as it is. `add` puts it back when it is gone (a payment that went out is never dropped). A write that
 * doesn't stick is tried again without the attempt's rawtx.
 */
function updateAttempt(
  store: PayStore,
  offerId: string,
  match: Pick<Attempt, 'quote_id' | 'txid'>,
  change: (a: Attempt) => Attempt | null,
  add?: Attempt,
): boolean {
  const all = readAttempts(store, offerId);
  const i = all.findIndex((a) => (match.quote_id ? a.quote_id === match.quote_id : a.txid === match.txid));
  let next: Attempt[];
  if (i >= 0) {
    const c = change(all[i]);
    next = c ? all.map((a, j) => (j === i ? c : a)) : all.filter((_, j) => j !== i);
  } else if (add) next = [...all, add];
  else return true;
  if (writeAttempts(store, offerId, next)) return true;
  return writeAttempts(
    store,
    offerId,
    next.map((a) => (a.quote_id === match.quote_id ? { ...a, rawtx: undefined } : a)),
  );
}

/** The refused or held claim for this offer (records from before 8 Nov had only txid + reason: never re-claimed). */
export function readFailed(store: PayStore, offerId: string): FailedClaim | null {
  const o = parse(store.get(failedKey(offerId)));
  if (!o || !str(o.txid)) return null;
  const f: FailedClaim = {
    quote_id: str(o.quote_id),
    txid: str(o.txid),
    code: str(o.code),
    reason: str(o.reason),
    tries: num(o.tries) || 1,
  };
  if (str(o.rawtx)) f.rawtx = str(o.rawtx);
  return f;
}

/** Writes the failed record and reads it back; then again without its rawtx. False: nothing kept (review #2). */
function writeFailed(store: PayStore, offerId: string, f: FailedClaim): boolean {
  for (const rec of f.rawtx ? [f, { ...f, rawtx: undefined }] : [f]) {
    const v = JSON.stringify(rec);
    store.set(failedKey(offerId), v);
    if (store.get(failedKey(offerId)) === v) return true;
  }
  return false;
}

/**
 * Refusals that may clear up (the server switched off for a deploy, KYC not finished yet, the offer or treasury
 * edited, signed out, a broadcaster that didn't answer, a quote past its grace that bit-sign still records): the
 * claim is kept and offered again. Re-claiming never pays.
 */
export const RECLAIM_CODES: ReadonlySet<string> = new Set([
  'not_configured',
  'kyc_required',
  'offer_changed',
  'quote_invalid',
  'quote_expired',
  'offer_closed',
  'unauthenticated',
  'not_named_investor',
  'broadcast_failed',
  'excess_choice',
]);
/** Retried with the same payment when the server gives no `retryable` flag (bit-sign INVEST_RETRYABLE + a 500). */
const RETRY_FALLBACK: ReadonlySet<string> = new Set([
  'not_seen',
  'not_confirmed',
  'rate_limited',
  'internal',
  // Sanctions screening down for a moment (503, retryable): the payment is safe, the record stays, never pay.
  'sanctions_unavailable',
]);
export const HELD_CODE = 'payment_held';

export const isReclaimable = (code: string) => RECLAIM_CODES.has(code);

type ErrorData = {
  code?: unknown;
  retryable?: unknown;
  refund_due?: unknown;
  payment_pending?: unknown;
  payment_held?: unknown;
  payment_returned?: unknown;
  refund_txid?: unknown;
  payment_txid?: unknown;
  txid?: unknown;
  quote_id?: unknown;
};
const errorData = (e: unknown): ErrorData | null =>
  ((e instanceof ChatApiError ? e.data : (e as { data?: unknown } | null)?.data) as ErrorData | null) ?? null;
const isHeld = (d: ErrorData | null) => str(d?.code) === HELD_CODE || d?.payment_held === true;

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

/** The quote route (or a claim) saying a payment for this offer is held for a compliance review (409 payment_held). */
export function paymentHeld(e: unknown): { txid: string } | null {
  const d = errorData(e);
  if (!isHeld(d)) return null;
  return { txid: (str(d?.payment_txid) || str(d?.txid)).toLowerCase() };
}

/**
 * Takes the server's waiting payment as one of this device's attempts, so the button becomes "Check payment" (claims
 * that quote_id + txid; never pays). Other attempts stay; a rawtx this device holds for the same txid is kept.
 */
export function adoptServerPending(
  store: PayStore,
  offerId: string,
  p: { quote_id: string; txid: string },
  now: () => number = Date.now,
): boolean {
  const all = readAttempts(store, offerId);
  const same = all.find((a) => a.quote_id === p.quote_id || a.txid === p.txid);
  const rec: Attempt = {
    quote_id: p.quote_id,
    memo: same?.memo ?? '',
    memo_script: same?.memo_script ?? '',
    startedAt: same?.startedAt || now(),
    txid: p.txid,
    fromServer: true,
  };
  if (same?.txid === p.txid && same.rawtx) rec.rawtx = same.rawtx;
  const rest = all.filter((a) => a !== same);
  store.remove(failedKey(offerId));
  return writeAttempts(store, offerId, [...rest, rec]);
}

/** Notes a held payment (claim or quote 409 payment_held) as this offer's final record. */
export function recordHeld(store: PayStore, offerId: string, txid: string, reason = 'held for a compliance review') {
  return writeFailed(store, offerId, { quote_id: '', txid, code: HELD_CODE, reason, tries: 1 });
}

/** A bShares payment found in the wallet with no record here (Pay's scan): kept so the card warns, never claimed. */
export function recordOrphan(store: PayStore, offerId: string, txid: string, now: () => number = Date.now): boolean {
  if (readAttempts(store, offerId).some((a) => a.txid === txid)) return true;
  return writeAttempts(store, offerId, [
    ...readAttempts(store, offerId),
    { quote_id: '', memo: '', memo_script: '', startedAt: now(), txid, orphan: true },
  ]);
}

/** Every txid this device's records hold for OTHER offers (so the scan never blames this offer for them). */
export function recordedTxids(store: PayStore, exceptOfferId: string): Set<string> {
  const out = new Set<string>();
  for (const k of store.keys?.() ?? []) {
    const m = /^bshares-claim(?:-failed)?:(.+)$/.exec(k);
    if (!m || m[1] === exceptOfferId) continue;
    for (const a of readAttempts(store, m[1])) if (a.txid) out.add(a.txid);
    const f = readFailed(store, m[1]);
    if (f?.txid) out.add(f.txid.toLowerCase());
  }
  return out;
}

/** Drops orphan attempts whose txid an offer now shows as its payment (the warning clears). */
export function dropKnownOrphans(store: PayStore, offerId: string, paymentTxids: ReadonlySet<string>): void {
  const all = readAttempts(store, offerId);
  const keep = all.filter((a) => !(a.orphan && a.txid && paymentTxids.has(a.txid)));
  if (keep.length !== all.length) writeAttempts(store, offerId, keep);
}

export type ClaimVerdict = {
  kind: 'retry' | 'reclaim' | 'final' | 'refund' | 'held' | 'returned';
  code: string;
  reason: string;
};

/**
 * What a refused claim means. A refund_due-style answer: recorded for a refund. payment_held: recorded, held for a
 * review. No answer, no code, or payment_pending: retry (the payment may be fine). Then the server's own
 * `retryable` flag, then the codes above.
 */
export function claimVerdict(e: unknown): ClaimVerdict {
  const data = errorData(e);
  const code = str(data?.code);
  const reason = (e instanceof Error && e.message) || code || 'no answer';
  // Already refunded by the company (409 payment_returned): final, nothing more to claim or pay for it.
  if (code === 'payment_returned' || data?.payment_returned === true)
    return { kind: 'returned', code: 'payment_returned', reason };
  if (isHeld(data)) return { kind: 'held', code: HELD_CODE, reason };
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
export const returnedMessage = (txid: string, refundTxid: string) =>
  `Your payment ${txid} was returned by the company${refundTxid ? ` (refund ${refundTxid})` : ''}.`;
export const HELD_MESSAGE = "Your payment was received and is held for a compliance review. Don't pay again.";
export const heldMessage = (txid: string) => (txid ? `${HELD_MESSAGE} Transaction ${txid}.` : HELD_MESSAGE);
export const CHECK_FIRST_MESSAGE = 'An earlier payment may have gone out. Check your history before paying again.';
export const CHECK_UNCHECKED_MESSAGE =
  "We couldn't look through your wallet for it, and an earlier payment may have gone out. Check your history before paying again.";
export const MAYBE_SENT_MESSAGE =
  "We can't confirm whether your payment went out. Don't pay again: tap Check payment, and check your History first.";
export const NO_RECORD_MESSAGE =
  "This device couldn't save a record of the payment, so it wasn't started: without one, a retry could pay twice. Nothing was sent.";
export const CHANGED_MESSAGE =
  'Another payment for this offer was just started or recorded on this device (another tab or window?). Nothing was sent: check it before paying again.';
export const AMOUNT_CHANGED_MESSAGE = 'The amount changed since the sheet opened. Check it and tap Pay again.';
export const QUOTE_REFRESHED_MESSAGE =
  'That quote was more than 8 minutes old, so a fresh one was fetched. Check it and tap Pay again.';
export const OTHER_DEVICE_NOTE = "If you already paid on another device, don't pay again: check there first.";

export const paidButUnclaimed = (txid: string, reason: string) =>
  `Your payment was sent but could not be matched to this offer (${reason}). Don't pay again: ask the company's directors to refund transaction ${txid}.`;
export const reclaimMessage = (txid: string, reason: string) =>
  `The claim for your payment was refused for now (${reason}). Don't pay again: your payment is transaction ${txid}. Tap Try the claim again once that's sorted.`;
export const askDirectorsMessage = (txid: string) =>
  `Ask the directors: quote no longer valid. Your payment is transaction ${txid}. Don't pay again.`;
export const staleMessage = (txid: string) =>
  `The network still can't see transaction ${txid} after an hour. Don't pay again yet: tap Search my wallet again.`;
export const abandonedMessage = (txid: string) =>
  `We can't find transaction ${txid} in this wallet as sent: it may have failed or been abandoned. ${CHECK_FIRST_MESSAGE}`;
export const paidNote = (txid: string) =>
  `Paid: transaction ${txid} is claimed for this offer. The directors approve the allotment next. Don't pay again.`;
export const extraPaymentMessage = (txid: string) =>
  `An earlier attempt also went out: ask the directors to refund transaction ${txid}.`;
export const orphanMessage = (txid: string) =>
  `This wallet already has a bShares payment to this treasury (transaction ${txid}) that this device has no record of. ${CHECK_FIRST_MESSAGE}`;
const retryMessage = (reason: string, button: string) =>
  `${reason} Your payment is saved on this device: tap ${button} again shortly. Don't pay again.`;
const failedMessage = (f: Pick<FailedClaim, 'txid' | 'code' | 'reason' | 'tries'>) =>
  f.code === HELD_CODE
    ? heldMessage(f.txid)
    : f.code === 'quote_invalid' && f.tries >= QUOTE_INVALID_ASK_AFTER
      ? askDirectorsMessage(f.txid)
      : isReclaimable(f.code)
        ? reclaimMessage(f.txid, f.reason)
        : paidButUnclaimed(f.txid, f.reason);

// ── Finding a payment the wallet may have made ───────────────────────────────────────────────────────────────────

type ListedAction = { txid: string; status: string; outputs?: { lockingScript?: string; satoshis?: number }[] };
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
 * The wallet's bShares action carrying any of these memo scripts (each quote's own OP_RETURN, unique per quote).
 * { found: false } only when the whole list was read; any error, or nothing to look for → null (couldn't check).
 */
export async function findPaidAction(
  listActions: ListActionsFn,
  memoScripts: string | string[],
): Promise<{ found: true; txid: string; memo_script: string } | { found: false } | null> {
  const want = new Set((Array.isArray(memoScripts) ? memoScripts : [memoScripts]).map((s) => s.toLowerCase()));
  want.delete('');
  if (!want.size) return null;
  try {
    for (let offset = 0; offset < 100_000; offset += PAGE) {
      const r = await listActions({
        labels: [BSHARES_LABEL],
        includeOutputs: true,
        includeOutputLockingScripts: true,
        limit: PAGE,
        offset,
      });
      for (const a of r.actions) {
        if (!a.txid || NOT_OUT.has(a.status)) continue;
        const o = a.outputs?.find((x) => want.has(x.lockingScript?.toLowerCase() ?? ''));
        if (o) return { found: true, txid: a.txid.toLowerCase(), memo_script: o.lockingScript!.toLowerCase() };
      }
      if (r.actions.length < PAGE || offset + r.actions.length >= r.totalActions) break;
    }
    return { found: false };
  } catch {
    return null;
  }
}

/** Newest-first pages of every action read when looking a txid up directly (bounded; past it → couldn't check). */
const TXID_PAGE = 1000;
const TXID_MAX_PAGES = 10;

/**
 * This txid among ALL the wallet's actions (no label filter), newest first: 'sent' when listed with a sent status,
 * 'absent' when the whole list was read without it (listActions already leaves failed ones out), null when it
 * couldn't be checked (an error, or more actions than the bound).
 */
export async function findTxidAction(listActions: ListActionsFn, txid: string): Promise<'sent' | 'absent' | null> {
  const want = txid.toLowerCase();
  try {
    const head = await listActions({
      labels: [],
      includeOutputs: false,
      includeOutputLockingScripts: false,
      limit: 1,
      offset: 0,
    });
    const total = head.totalActions;
    for (let page = 0; page < TXID_MAX_PAGES; page++) {
      const end = total - page * TXID_PAGE;
      if (end <= 0) return 'absent';
      const offset = Math.max(0, end - TXID_PAGE);
      const r = await listActions({
        labels: [],
        includeOutputs: false,
        includeOutputLockingScripts: false,
        limit: end - offset,
        offset,
      });
      const hit = r.actions.find((x) => x.txid?.toLowerCase() === want);
      if (hit) return NOT_OUT.has(hit.status) ? 'absent' : 'sent';
      if (offset === 0) return 'absent';
    }
    return null;
  } catch {
    return null;
  }
}

const MEMO_PREFIX_HEX = Array.from(new TextEncoder().encode(BSHARES_MEMO_PREFIX))
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('');
/** OP_FALSE OP_RETURN <one direct push> starting "bitsign-bshares " (any quote's memo). */
export const isBsharesMemoScript = (script: string) => {
  const s = script.toLowerCase();
  const len = parseInt(s.slice(4, 6), 16);
  return (
    s.startsWith('006a') && len >= 1 && len <= 75 && s.length === 6 + len * 2 && s.slice(6).startsWith(MEMO_PREFIX_HEX)
  );
};

/**
 * Pay's scan with nothing recorded (review #5): a recent action of this wallet with a bShares memo that also pays this
 * treasury at least the offer's sats, and isn't a payment an offer already shows. Bounded: the latest 100 bShares
 * actions, or the latest 50 actions when none carries the label. null when none (or the wallet can't be read).
 */
export async function findOrphanPayment(
  listActions: ListActionsFn,
  treasuryScript: string,
  minSats: number,
  knownTxids: ReadonlySet<string>,
): Promise<string | null> {
  const treasury = treasuryScript.toLowerCase();
  const latest = async (labels: string[], limit: number) => {
    const head = await listActions({
      labels,
      includeOutputs: false,
      includeOutputLockingScripts: false,
      limit: 1,
      offset: 0,
    });
    if (!head.totalActions) return [];
    const r = await listActions({
      labels,
      includeOutputs: true,
      includeOutputLockingScripts: true,
      limit,
      offset: Math.max(0, head.totalActions - limit),
    });
    return r.actions;
  };
  try {
    let actions = await latest([BSHARES_LABEL], 100);
    if (!actions.length) actions = await latest([], 50);
    const hit = actions.find(
      (a) =>
        !!a.txid &&
        !NOT_OUT.has(a.status) &&
        !knownTxids.has(a.txid.toLowerCase()) &&
        a.outputs?.some((o) => isBsharesMemoScript(o.lockingScript ?? '')) &&
        a.outputs?.some((o) => o.lockingScript?.toLowerCase() === treasury && (o.satoshis ?? 0) >= minSats),
    );
    return hit ? hit.txid.toLowerCase() : null;
  } catch {
    return null;
  }
}

// ── The flow ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Runs `fn` holding an exclusive lock named `name`, if it is free right now; null when another holder has it.
 * Browsers: navigator.locks (Web Locks, across every tab and window of this origin).
 */
export type PayLock = <T>(name: string, fn: () => Promise<T>) => Promise<T | null>;

type LockManagerLike = {
  request: (name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => unknown) => Promise<unknown>;
};
/** navigator.locks with ifAvailable, or null where the browser has none (then payAndClaim's settle check is used). */
export function webLock(): PayLock | null {
  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
  if (!locks || typeof locks.request !== 'function') return null;
  return <T>(name: string, fn: () => Promise<T>) =>
    locks.request(name, { ifAvailable: true }, (lock) => (lock ? fn() : null)) as Promise<T | null>;
}

/** Without Web Locks: after writing its attempt, a tab waits this long and pays only if its attempt is still latest. */
export const SETTLE_MS = 150;

export type PayDeps = {
  store: PayStore;
  listActions: ListActionsFn;
  /** The claim call (the page adds the offer id and excessChoice). */
  claim: (c: { quote_id: string; txid: string; rawtx?: string }) => Promise<ClaimAnswer>;
  now?: () => number;
  /** The cross-tab lock: undefined → navigator.locks when there is one; null → none (the settle check). */
  lock?: PayLock | null;
  /** The settle wait without a lock (tests shorten it). */
  settleMs?: number;
};

export type PayOutcome =
  /** `message`: an earlier attempt also went out (a second payment, for the directors to refund). */
  | { kind: 'claimed'; message?: string }
  | { kind: 'refund'; message: string; txid: string }
  | { kind: 'held'; message: string; txid: string }
  /** The company already refunded it (payment_returned): records cleared, no button for it. */
  | { kind: 'returned'; message: string; txid: string }
  | { kind: 'retry'; message: string; txid: string }
  /** A txid the network hasn't seen for over an hour: "Search my wallet again". */
  | { kind: 'stale'; message: string; txid: string }
  | { kind: 'reclaim'; message: string; txid: string }
  | { kind: 'final'; message: string; txid: string }
  /** The wallet's answer leaves the payment's fate open and it isn't in the wallet: kept, never "pay again". */
  | { kind: 'maybe-sent'; message: string }
  /** Proven not sent (or never started): that attempt is forgotten, paying again is fine. */
  | { kind: 'not-sent'; message: string }
  /** A payment was started (or found) but can't be claimed: ask before paying again (Cancel first). */
  | { kind: 'check-first'; message: string }
  /** The record changed since the sheet was opened (another tab): nothing paid; look again. */
  | { kind: 'changed'; message: string }
  /** The fresh quote at Pay time differs from the sheet's: nothing paid; show the sheet again with it. */
  | { kind: 'requote'; message: string; quote: PlacementQuote };

/** What the Pay area shows for this offer on this device. */
export type PayState =
  | { kind: 'none' }
  /** A claim for this offer succeeded on this device: Paid; nothing more to do here. */
  | { kind: 'claimed'; rec: { txid: string } }
  | { kind: 'pending'; rec: Attempt; all: Attempt[] }
  | { kind: 'stale'; rec: Attempt; all: Attempt[] }
  | { kind: 'reclaim'; rec: FailedClaim }
  | { kind: 'held'; rec: FailedClaim }
  | { kind: 'final'; rec: FailedClaim };

/** The attempt to claim: the latest with a quote and a txid that isn't abandoned. */
const claimable = (all: Attempt[]) =>
  [...all].reverse().find((a) => !!a.txid && !!a.quote_id && !a.orphan && !a.abandoned && !a.extra) ?? null;

export function payState(store: PayStore, offerId: string, now: number = Date.now()): PayState {
  const f = readFailed(store, offerId);
  if (f)
    return f.code === HELD_CODE
      ? { kind: 'held', rec: f }
      : isReclaimable(f.code)
        ? { kind: 'reclaim', rec: f }
        : { kind: 'final', rec: f };
  const all = readAttempts(store, offerId);
  const paidTxid = readClaimed(store, offerId);
  // Claimed: Paid, unless an earlier attempt also went out (then that note, for the directors to refund).
  if (paidTxid && !all.some((a) => a.extra)) return { kind: 'claimed', rec: { txid: paidTxid } };
  if (!all.length) return { kind: 'none' };
  const c = claimable(all);
  if (c && c.notSeenSince && now - c.notSeenSince > NOT_SEEN_DEAD_MS) return { kind: 'stale', rec: c, all };
  return { kind: 'pending', rec: c ?? all.find((a) => a.extra) ?? all[all.length - 1], all };
}

/** The button for each state; null = no button (a payment that can only be refunded, or is held). */
export const PAY_BUTTON: Record<PayState['kind'], string | null> = {
  none: 'Pay',
  claimed: null,
  pending: 'Check payment',
  stale: 'Search my wallet again',
  reclaim: 'Try the claim again',
  held: null,
  final: null,
};

/** The line under the offer for this state (none: the second-device note). */
export function payNoteFor(s: PayState): string {
  if (s.kind === 'none') return OTHER_DEVICE_NOTE;
  if (s.kind === 'claimed') return paidNote(s.rec.txid);
  if (s.kind === 'held' || s.kind === 'reclaim' || s.kind === 'final') return failedMessage(s.rec);
  if (s.kind === 'stale') return staleMessage(s.rec.txid!);
  const a = s.rec;
  if (a.extra && a.txid) return extraPaymentMessage(a.txid);
  if (a.orphan && a.txid) return orphanMessage(a.txid);
  if (a.txid && !a.abandoned)
    return `Your payment went out: transaction ${a.txid}. Don't pay again: tap Check payment to claim it.`;
  if (a.txid && a.abandoned) return abandonedMessage(a.txid);
  const at = a.startedAt ? ` at ${new Date(a.startedAt).toLocaleString('en-GB')}` : '';
  return `A payment was started on this device${at}. Don't pay again: tap Check payment to look for it first.`;
}

/** What the confirm sheet was opened over; paying goes ahead only if the record is still exactly that. */
export type OpenedOver = { kind: 'none' } | { kind: 'attempt'; quote_id: string; txid: string; startedAt: number };

/** The state a sheet opened now is over. null: there is a claimable payment, so no sheet may pay. */
export function openedOver(store: PayStore, offerId: string): OpenedOver | null {
  if (readFailed(store, offerId) || readClaimed(store, offerId)) return null;
  const all = readAttempts(store, offerId);
  if (!all.length) return { kind: 'none' };
  // A payment with a txid is only ever claimed; a stale one may be paid over only once "Search my wallet again" found
  // the wallet no longer has it as sent (then it is abandoned, and no longer claimable).
  if (claimable(all)) return null;
  const a = all[all.length - 1];
  return { kind: 'attempt', quote_id: a.quote_id, txid: a.txid ?? '', startedAt: a.startedAt };
}

export const sameOpened = (a: OpenedOver | null, b: OpenedOver) =>
  !!a &&
  a.kind === b.kind &&
  (a.kind === 'none' ||
    (b.kind === 'attempt' && a.quote_id === b.quote_id && a.txid === b.txid && a.startedAt === b.startedAt));

/** Forget everything for this offer (claimed, or recorded for a refund). */
function clearAll(d: PayDeps, offerId: string) {
  d.store.remove(pendingKey(offerId));
  d.store.remove(failedKey(offerId));
}

async function claimWith(d: PayDeps, offerId: string, a: Attempt, prior: FailedClaim | null): Promise<PayOutcome> {
  const txid = a.txid!;
  const now = (d.now ?? Date.now)();
  let answer: ClaimAnswer | null;
  try {
    answer = await d.claim({ quote_id: a.quote_id, txid, ...(a.rawtx ? { rawtx: a.rawtx } : {}) });
  } catch (e) {
    const v = claimVerdict(e);
    if (v.kind === 'returned') {
      clearAll(d, offerId);
      const data = errorData(e);
      const paid = str(data?.payment_txid).toLowerCase() || txid;
      return { kind: 'returned', message: returnedMessage(paid, str(data?.refund_txid).toLowerCase()), txid: paid };
    }
    if (v.kind === 'refund') {
      clearAll(d, offerId);
      const paid = str(errorData(e)?.payment_txid).toLowerCase() || txid;
      return { kind: 'refund', message: refundRecorded(paid), txid: paid };
    }
    if (v.kind === 'retry') {
      // The record stays where it is, so the next tap claims the same payment again; not_seen is timed (dead rule).
      let since: number | undefined;
      if (!prior) {
        since = v.code === 'not_seen' ? a.notSeenSince || now : undefined;
        updateAttempt(d.store, offerId, a, (x) => ({ ...x, notSeenSince: since }));
      }
      if (since && now - since > NOT_SEEN_DEAD_MS) return { kind: 'stale', message: staleMessage(txid), txid };
      return { kind: 'retry', message: retryMessage(v.reason, prior ? 'Try the claim again' : 'Check payment'), txid };
    }
    const paid = v.kind === 'held' ? str(errorData(e)?.payment_txid).toLowerCase() || txid : txid;
    const failed: FailedClaim = {
      quote_id: a.quote_id,
      txid: paid,
      code: v.code,
      reason: v.reason,
      tries: prior && prior.code === v.code ? prior.tries + 1 : 1,
    };
    if (a.rawtx && a.rawtx.length <= RAWTX_STORE_MAX) failed.rawtx = a.rawtx;
    // Only once the failed record is safely kept is the pending attempt dropped; otherwise the attempt stays.
    if (writeFailed(d.store, offerId, failed) && !prior) updateAttempt(d.store, offerId, a, () => null);
    if (v.kind === 'held') return { kind: 'held', message: heldMessage(paid), txid: paid };
    return { kind: v.kind, message: failedMessage(failed), txid };
  }
  // Claimed: only this attempt is done. Any earlier attempt without a txid is looked for once; one that also went
  // out is kept (marked extra) for the directors to refund, never claimed or paid over.
  const refundDue = answer?.status === 'refund_due' || answer?.refund_due === true;
  if (!refundDue) d.store.set(claimedKey(offerId), JSON.stringify({ txid, at: (d.now ?? Date.now)() }));
  d.store.remove(failedKey(offerId));
  updateAttempt(d.store, offerId, a, () => null);
  const others = readAttempts(d.store, offerId).filter((x) => !x.txid && x.memo_script);
  let extra = '';
  if (others.length) {
    const found = await findPaidAction(
      d.listActions,
      others.map((x) => x.memo_script),
    );
    if (found?.found && found.txid !== txid) {
      const o = others.find((x) => x.memo_script === found.memo_script)!;
      updateAttempt(d.store, offerId, o, (x) => ({ ...x, txid: found.txid, extra: true }));
      extra = extraPaymentMessage(found.txid);
    }
  }
  if (refundDue)
    return { kind: 'refund', message: extra ? `${refundRecorded(txid)} ${extra}` : refundRecorded(txid), txid };
  return extra ? { kind: 'claimed', message: extra } : { kind: 'claimed' };
}

/**
 * "Search my wallet again" on a txid the network hasn't seen for over an hour: re-runs the memo search. Still in the
 * wallet as sent → claim it again. Gone from a complete listing → marked abandoned and the person may pay again,
 * warned. bit-sign verified it (fromServer) → only claimed. Never pays.
 */
async function searchAgain(d: PayDeps, offerId: string, a: Attempt): Promise<PayOutcome> {
  if (a.fromServer) return claimWith(d, offerId, a, null);
  // Both ways: the memo (bShares actions) and the txid itself (every action, no label filter). Abandoned only when
  // both lookups read to the end and neither shows it with a sent status.
  const byMemo = a.memo_script ? await findPaidAction(d.listActions, a.memo_script) : ({ found: false } as const);
  if (byMemo?.found) return claimWith(d, offerId, a, null);
  const byTxid = await findTxidAction(d.listActions, a.txid!);
  if (byTxid === 'sent') return claimWith(d, offerId, a, null);
  if (byMemo === null || byTxid === null)
    return { kind: 'retry', message: `${CHECK_UNCHECKED_MESSAGE} Don't pay again yet.`, txid: a.txid! };
  updateAttempt(d.store, offerId, a, (x) => ({ ...x, abandoned: true }));
  return { kind: 'check-first', message: abandonedMessage(a.txid!) };
}

/**
 * The button on an offer with a record ("Check payment" / "Try the claim again" / "Search my wallet again"). Never
 * pays: it claims a payment already made, finds one the wallet made, or says to check before paying again. null when
 * nothing is recorded.
 */
export async function checkPayment(d: PayDeps, offerId: string): Promise<PayOutcome | null> {
  const s = payState(d.store, offerId, (d.now ?? Date.now)());
  if (s.kind === 'none') return null;
  if (s.kind === 'claimed') return { kind: 'claimed', message: paidNote(s.rec.txid) };
  if (s.kind === 'held') return { kind: 'held', message: heldMessage(s.rec.txid), txid: s.rec.txid };
  if (s.kind === 'final') return { kind: 'final', message: failedMessage(s.rec), txid: s.rec.txid };
  if (s.kind === 'reclaim') return claimWith(d, offerId, { ...s.rec, memo: '', memo_script: '', startedAt: 0 }, s.rec);
  if (s.kind === 'stale') return searchAgain(d, offerId, s.rec);
  const c = claimable(s.all);
  if (c) return claimWith(d, offerId, c, null);
  // Attempts without a txid: look for any of them in the wallet by its memo.
  const unfound = s.all.filter((a) => !a.txid && a.memo_script);
  const found = unfound.length
    ? await findPaidAction(
        d.listActions,
        unfound.map((a) => a.memo_script),
      )
    : null;
  if (found?.found) {
    const a = unfound.find((x) => x.memo_script === found.memo_script)!;
    const withTx = { ...a, txid: found.txid };
    updateAttempt(d.store, offerId, a, () => withTx, withTx);
    return claimWith(d, offerId, withTx, null);
  }
  const orphan = s.all.find((a) => a.orphan && a.txid);
  const abandoned = s.all.find((a) => a.abandoned && a.txid);
  const message = orphan
    ? orphanMessage(orphan.txid!)
    : abandoned
      ? abandonedMessage(abandoned.txid!)
      : unfound.length && found === null
        ? CHECK_UNCHECKED_MESSAGE
        : CHECK_FIRST_MESSAGE;
  return { kind: 'check-first', message };
}

/** True when an error from createAction leaves open whether the payment went out (17c: anything but proof). */
export function maybeSent(e: unknown): boolean {
  if ((e as { code?: unknown } | null)?.code === STORAGE_MAYBE_SENT_CODE) return true;
  return classifySendError(e, 'send').moneyMoved !== 'no';
}

/**
 * Pays a checked quote and claims it. Compare-and-set: only over the exact state the sheet was opened over
 * (`opened`); anything else (another tab started or recorded a payment) → 'changed', nothing paid. The attempt is
 * saved first, next to any earlier ones (no record → no payment). If the wallet throws, the payment is looked for by
 * its memo; found → claimed; proven not sent → that attempt is forgotten; otherwise kept as "maybe sent".
 */
export async function payAndClaim(
  d: PayDeps,
  offerId: string,
  q: Pick<PlacementQuote, 'quote_id' | 'memo' | 'memo_script'>,
  pay: () => Promise<{ txid: string; rawtx?: string }>,
  opened: OpenedOver,
  /**
   * Runs inside the lock, before anything is written or paid: a fresh look at the server (quote/status) and the
   * wallet. null = go ahead; an outcome = stop with it (offer paid or closed, a payment pending or held, the amount
   * changed, an unrecorded payment found). The state is compared again afterwards.
   */
  fresh?: () => Promise<PayOutcome | null>,
): Promise<PayOutcome> {
  const now = (d.now ?? Date.now)();
  const changed: PayOutcome = { kind: 'changed', message: CHANGED_MESSAGE };
  const attempt: Attempt = {
    quote_id: q.quote_id,
    memo: q.memo,
    memo_script: q.memo_script.toLowerCase(),
    startedAt: now,
  };
  const lock = d.lock === undefined ? webLock() : d.lock;
  type Started = { done: PayOutcome } | { paid: { txid: string; rawtx?: string } } | { error: unknown };
  // Check + write + createAction as one step: under the cross-tab lock, or (no lock) checked again after a settle.
  const start = async (): Promise<Started> => {
    if (!sameOpened(openedOver(d.store, offerId), opened)) return { done: changed };
    if (fresh) {
      const stop = await fresh();
      if (stop) return { done: stop };
      if (!sameOpened(openedOver(d.store, offerId), opened)) return { done: changed };
    }
    const before = readAttempts(d.store, offerId);
    if (!writeAttempts(d.store, offerId, [...before, attempt])) {
      // Take back only our own attempt if it half-landed; whatever else is there now (another tab's) stays.
      updateAttempt(d.store, offerId, attempt, () => null);
      return { done: { kind: 'not-sent', message: NO_RECORD_MESSAGE } };
    }
    if (!lock) {
      await new Promise((r) => setTimeout(r, d.settleMs ?? SETTLE_MS));
      const latest = readAttempts(d.store, offerId).at(-1);
      if (latest?.quote_id !== attempt.quote_id || latest.startedAt !== attempt.startedAt) {
        // Another tab wrote meanwhile: this one steps back without paying.
        updateAttempt(d.store, offerId, attempt, () => null);
        return { done: changed };
      }
    }
    try {
      return { paid: await pay() };
    } catch (error) {
      return { error };
    }
  };
  const started = lock ? ((await lock(`bshares-pay:${offerId}`, start)) ?? { done: changed }) : await start();
  if ('done' in started) return started.done;
  let paid: { txid: string; rawtx?: string };
  if ('paid' in started) paid = started.paid;
  else {
    const e = started.error;
    const found = await findPaidAction(d.listActions, attempt.memo_script);
    if (found?.found) {
      const withTx = { ...attempt, txid: found.txid };
      updateAttempt(d.store, offerId, attempt, () => withTx, withTx);
      return claimWith(d, offerId, withTx, null);
    }
    if (!maybeSent(e)) {
      updateAttempt(d.store, offerId, attempt, () => null);
      return { kind: 'not-sent', message: classifySendError(e, 'send').message };
    }
    return { kind: 'maybe-sent', message: MAYBE_SENT_MESSAGE };
  }
  const txid = paid.txid.toLowerCase();
  const stored: Attempt = { ...attempt, txid };
  if (paid.rawtx && paid.rawtx.length <= RAWTX_STORE_MAX) stored.rawtx = paid.rawtx;
  // Only this attempt changes (by quote_id); put back if another tab cleared the record meanwhile.
  updateAttempt(d.store, offerId, attempt, (x) => ({ ...x, txid, rawtx: stored.rawtx }), stored);
  // The first claim carries the signed tx even when it was too big to keep.
  return claimWith(d, offerId, { ...stored, rawtx: paid.rawtx }, null);
}
