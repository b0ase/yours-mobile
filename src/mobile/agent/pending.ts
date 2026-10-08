/**
 * The paid message in flight, kept on this device so a paid answer survives a reload or an app restart
 * (owner, 6 Oct 2026: "a paid answer is lost if the page reloads before it arrives. The test wallet paid 1¢
 * and got nothing"). Per-device UI state in localStorage, one slot per wallet account.
 *
 *   before pay   saved with txid null  (the quote and the question)
 *   after pay    saved with the txid   (proof of payment: the answer is re-asked with the SAME quoteId + txid,
 *                                      which bit-sign accepts without a second payment)
 *   answered     cleared
 *
 * Holds no keys: the question, the quote and a txid.
 */
import type { AgentMessage } from './agent';
import { isP2pkhAddress, type Quote } from './paid';

export type PendingPaid = {
  /** Wallet identity address the message was paid from (another account never resumes it). */
  account: string;
  quote: Quote;
  /** null = saved before the payment went out (whether it did is unknown after a reload). */
  txid: string | null;
  /** Transcript sent for the answer. */
  messages: AgentMessage[];
  /** The conversation as shown when it was sent (ends with the user's message). */
  shown: AgentMessage[];
  at: number;
};

const KEY = 'bwallet.agent.pending';
/** A paid answer this old is given up on locally (the quote is long gone server side). */
export const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

const isTxid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v);

const cleanMsgs = (v: unknown): AgentMessage[] | null => {
  if (!Array.isArray(v)) return null;
  const out: AgentMessage[] = [];
  for (const m of v) {
    const r = m && typeof m === 'object' ? (m as Record<string, unknown>) : {};
    if ((r.role !== 'user' && r.role !== 'assistant') || typeof r.text !== 'string') return null;
    out.push({ role: r.role, text: r.text });
  }
  return out;
};

export const parsePending = (raw: unknown, now = Date.now()): PendingPaid | null => {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!r || typeof r.account !== 'string' || !r.account) return null;
  const q = r.quote && typeof r.quote === 'object' ? (r.quote as Record<string, unknown>) : null;
  if (
    !q ||
    typeof q.quoteId !== 'string' ||
    !/^[\w-]{8,64}$/.test(q.quoteId) ||
    typeof q.sats !== 'number' ||
    !isP2pkhAddress(q.payTo) ||
    typeof q.expiresAt !== 'number'
  )
    return null;
  const txid = r.txid === null ? null : isTxid(r.txid) ? r.txid.toLowerCase() : undefined;
  if (txid === undefined) return null;
  const messages = cleanMsgs(r.messages);
  const shown = cleanMsgs(r.shown);
  if (!messages?.length || !shown) return null;
  const at = typeof r.at === 'number' ? r.at : 0;
  if (!at || now - at > PENDING_MAX_AGE_MS) return null;
  return {
    account: r.account,
    quote: { quoteId: q.quoteId, sats: q.sats, payTo: q.payTo, expiresAt: q.expiresAt },
    txid,
    messages,
    shown,
    at,
  };
};

/** The pending paid message for this account, if any. */
export const loadPending = (account: string | undefined, now = Date.now()): PendingPaid | null => {
  if (!account) return null;
  try {
    const p = parsePending(JSON.parse(localStorage.getItem(KEY) ?? 'null'), now);
    return p && p.account === account ? p : null;
  } catch {
    return null;
  }
};

export const savePending = (p: PendingPaid) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage full / private mode: the in-memory retry still works this session */
  }
};

export const clearPending = () => {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
};

/** bit-sign's error code from a failed call (ChatApiError.data.code), if any. */
export const errorCode = (e: unknown): string | null => {
  const d = e && typeof e === 'object' ? (e as { data?: unknown }).data : null;
  const c = d && typeof d === 'object' ? (d as Record<string, unknown>).code : null;
  return typeof c === 'string' ? c : null;
};

/**
 * Codes after which re-asking with the same quoteId + txid can never succeed: stop retrying and say so plainly.
 * `quote_used` = bit-sign answered but the answer never arrived (until bit-sign returns the stored answer on retry).
 */
export const FINAL_CODES = new Set([
  'quote_used',
  'no_quote',
  'quote_paid_other',
  'txid_used',
  'quote_expired',
  'bad_quote',
  'bad_txid',
]);

export const finalText = (code: string) =>
  code === 'quote_used'
    ? 'Your paid answer was sent but did not reach this device, and it can no longer be fetched. Contact bCorp support with the payment in Activity for a refund.'
    : code === 'quote_expired'
      ? 'The quote expired before your payment was seen. Contact bCorp support with the payment in Activity for a refund.'
      : 'This paid message could not be answered. Contact bCorp support with the payment in Activity for a refund.';
