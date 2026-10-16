/**
 * Business agents in chat (bit-sign PR "Business agents", lib/business-agent-rules.ts): a room host
 * sets up an AI agent from their website; it answers customers and can propose an order.
 *
 * ⚠ MONEY MOVES ONLY HERE, ON THE CUSTOMER'S TAP. The agent's order message is a proposal. Pay
 * fetches the order from the server, `checkPaySpec` re-checks it (it is for me, it is open, the
 * address is a mainnet P2PKH, the sats match the order, the OP_RETURN is this order's reference,
 * the total is within the $100 v1 cap), the wallet's approval card shows it, and only "Allow"
 * sends. The model never sees keys and never chooses where the money goes: the server fixes
 * `pay_to` to the room owner's verified bWalletX address.
 */
import { useEffect, useState } from 'react';
import type { BchatClient } from './api';
import type { ChatMessage } from './messages';

export const ORDER_EVENT = 'business_order';
export const ORDER_UPDATE_EVENT = 'business_order_update';
export const REPLY_EVENT = 'business_agent_reply';
export const AI_LABEL = 'AI agent';
export const ORDER_MAX_USD = 100;

const path = (ticker: string) => `/api/bitsign/rooms/${encodeURIComponent(ticker.replace(/^\$/, ''))}`;
const norm = (h: unknown) =>
  String(h ?? '')
    .trim()
    .replace(/^[@$]/, '')
    .toLowerCase();

export interface OrderLine {
  id: string;
  name: string;
  qty: number;
  unitUsd: number;
}
export type OrderStatus = 'proposed' | 'paid' | 'cancelled' | 'refunded';

export interface OrderCardInfo {
  orderId: string;
  customer: string;
  business: string;
  lines: OrderLine[];
  note: string;
  totalUsd: number;
  sats: number;
  expiresAt: string;
  status: OrderStatus;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v));

const linesOf = (v: unknown): OrderLine[] =>
  (Array.isArray(v) ? v : [])
    .map((x) => (x || {}) as Record<string, unknown>)
    .map((x) => ({ id: String(x.id ?? ''), name: String(x.name ?? ''), qty: num(x.qty), unitUsd: num(x.unitUsd) }))
    .filter((l) => l.name && l.qty > 0 && l.unitUsd > 0);

/** The agent's order message, else null. */
export const orderCardInfo = (m: Pick<ChatMessage, 'event_type' | 'event_payload'>): OrderCardInfo | null => {
  if (m.event_type !== ORDER_EVENT) return null;
  const p = (m.event_payload || {}) as Record<string, unknown>;
  const orderId = String(p.order_id ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) return null;
  return {
    orderId,
    customer: norm(p.customer),
    business: norm(p.business),
    lines: linesOf(p.items),
    note: typeof p.note === 'string' ? p.note : '',
    totalUsd: num(p.total_usd) || 0,
    sats: Math.floor(num(p.sats) || 0),
    expiresAt: String(p.expires_at ?? ''),
    status: 'proposed',
  };
};

/** Latest status per order id from the room's update events (paid / cancelled / refunded). */
export const orderStatuses = (
  messages: Pick<ChatMessage, 'event_type' | 'event_payload'>[],
): Map<string, OrderStatus> => {
  const out = new Map<string, OrderStatus>();
  for (const m of messages) {
    if (m.event_type !== ORDER_UPDATE_EVENT) continue;
    const p = (m.event_payload || {}) as Record<string, unknown>;
    const s = p.status;
    if (typeof p.order_id === 'string' && (s === 'paid' || s === 'cancelled' || s === 'refunded'))
      out.set(p.order_id, s);
  }
  return out;
};

/** An agent's message (reply or order): shows the "AI agent" label. */
export const isBusinessAgentMessage = (m: Pick<ChatMessage, 'event_type'>) =>
  m.event_type === REPLY_EVENT || m.event_type === ORDER_EVENT;

export const fmtUsd = (n: number) => `$${(Number(n) || 0).toFixed(2)}`;
export const isExpired = (iso: string, now = Date.now()) => !!iso && Date.parse(iso) < now;

// ── What the server says to pay, re-checked here ──

export interface OrderRow {
  id: string;
  customer_handle: string;
  business_handle: string;
  items: unknown;
  note?: string | null;
  total_usd: number | string;
  sats: number | string;
  pay_to: string;
  pay_to_paymail?: string | null;
  status: OrderStatus;
  expires_at: string;
  paid_txid?: string | null;
  refund_to?: string | null;
  refund_txid?: string | null;
  created_at: string;
}
export interface PaySpec {
  address: string;
  sats: number;
  data: string[];
  reference: string;
}
export interface OrderDetail {
  order: OrderRow;
  pay: PaySpec | null;
  refund: { address: string; data: string[] } | null;
}

const P2PKH = /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const hexOf = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');
export const orderReference = (id: string) => `bchatx-order:${id}`;
export const refundReference = (id: string) => `bchatx-refund:${id}`;

export type PayCheck = { ok: true; spec: PaySpec } | { ok: false; why: string };

/** Defence in depth: the wallet refuses a spec that is not exactly this open order, for me. */
export const checkPaySpec = (
  d: OrderDetail | null,
  me: string,
  expected?: Pick<OrderCardInfo, 'orderId' | 'sats'>,
): PayCheck => {
  if (!d?.order) return { ok: false, why: 'Order not found' };
  const o = d.order;
  if (norm(o.customer_handle) !== norm(me)) return { ok: false, why: 'This order is for someone else' };
  if (o.status !== 'proposed') return { ok: false, why: `This order is ${o.status}` };
  if (isExpired(o.expires_at))
    return { ok: false, why: 'This order has expired. Ask the agent again for a fresh price.' };
  const s = d.pay;
  if (!s) return { ok: false, why: 'This order cannot be paid' };
  if (expected && expected.orderId !== o.id) return { ok: false, why: 'Order mismatch' };
  if (!P2PKH.test(s.address) || s.address !== o.pay_to)
    return { ok: false, why: 'The payment address looks wrong; not paying' };
  const sats = Number(s.sats);
  if (
    !Number.isInteger(sats) ||
    sats <= 0 ||
    sats !== Number(o.sats) ||
    (expected && expected.sats && expected.sats !== sats)
  ) {
    return { ok: false, why: 'The amount does not match the order; not paying' };
  }
  if (!(Number(o.total_usd) > 0) || Number(o.total_usd) > ORDER_MAX_USD)
    return { ok: false, why: `Orders in chat are limited to $${ORDER_MAX_USD}` };
  if (s.data.length !== 1 || s.data[0] !== hexOf(orderReference(o.id)))
    return { ok: false, why: 'The order reference is wrong; not paying' };
  return { ok: true, spec: { ...s, sats } };
};

/** The two outputs the wallet sends: the business, and the order's reference (so the payment is provably mine). */
export const payRequests = (s: PaySpec) => [
  { address: s.address, satoshis: s.sats },
  { satoshis: 0, data: s.data },
];

export const refundCheck = (
  d: OrderDetail | null,
  me: string,
): { ok: true; address: string; data: string[] } | { ok: false; why: string } => {
  if (!d?.order || !d.refund) return { ok: false, why: 'This order cannot be refunded here' };
  if (norm(d.order.business_handle) !== norm(me)) return { ok: false, why: 'Only the business refunds' };
  if (d.order.status !== 'paid') return { ok: false, why: `This order is ${d.order.status}` };
  if (!P2PKH.test(d.refund.address) || d.refund.address !== d.order.refund_to)
    return { ok: false, why: 'Unknown refund address' };
  if (d.refund.data[0] !== hexOf(refundReference(d.order.id))) return { ok: false, why: 'Refund reference is wrong' };
  return { ok: true, address: d.refund.address, data: d.refund.data };
};

// ── Profile (the host's editor) ──

export interface BizItem {
  id?: string;
  name: string;
  description: string;
  priceUsd: number | null;
}
export interface BizFaq {
  q: string;
  a: string;
}
export interface BizProfile {
  name: string;
  summary: string;
  items: BizItem[];
  faqs: BizFaq[];
  tone: string;
  hours: string;
  sourceUrl: string;
}
export interface BizConfig {
  handle: string;
  enabled: boolean;
  draft: BizProfile | null;
  profile: BizProfile | null;
  publishedAt: string | null;
  orderMaxUsd: number;
  payments: { ready: boolean; paymail: string | null; address: string | null };
}
export interface BizState {
  canEdit: boolean;
  agent: (BizProfile & { handle: string; label: string }) | null;
  config: BizConfig | null;
}

export const emptyProfile = (): BizProfile => ({
  name: '',
  summary: '',
  items: [],
  faqs: [],
  tone: '',
  hours: '',
  sourceUrl: '',
});

/** Price text the host typed → dollars, or null ("not stated"). */
export const parsePriceInput = (s: string): number | null => {
  const t = String(s || '').replace(/[$,\s]/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 && n <= 100_000 ? Math.round(n * 100) / 100 : null;
};

export const looksLikeUrl = (s: string) => {
  try {
    const u = new URL(/^https?:\/\//i.test(s.trim()) ? s.trim() : `https://${s.trim()}`);
    return (u.protocol === 'https:' || u.protocol === 'http:') && /\./.test(u.hostname);
  } catch {
    return false;
  }
};
export const normaliseUrl = (s: string) => (/^https?:\/\//i.test(s.trim()) ? s.trim() : `https://${s.trim()}`);

// ── Calls ──

export const getBusiness = async (c: BchatClient, ticker: string) =>
  (await c.request('GET', `${path(ticker)}/business-agent`)) as BizState;
export const draftBusiness = async (c: BchatClient, ticker: string, url: string) =>
  (
    (await c.request('POST', `${path(ticker)}/business-agent`, { action: 'draft', url: normaliseUrl(url) })) as {
      draft: BizProfile;
    }
  ).draft;
export const saveBusiness = async (c: BchatClient, ticker: string, profile: BizProfile, publish: boolean) =>
  c.request('POST', `${path(ticker)}/business-agent`, { action: publish ? 'publish' : 'save', profile });
export const disableBusiness = async (c: BchatClient, ticker: string) =>
  c.request('POST', `${path(ticker)}/business-agent`, { action: 'disable' });
export const listOrders = async (c: BchatClient, ticker: string) =>
  (await c.request('GET', `${path(ticker)}/orders`)) as { orders: OrderRow[]; isOwner: boolean };
export const getOrder = async (c: BchatClient, ticker: string, id: string) =>
  (await c.request('GET', `${path(ticker)}/orders/${encodeURIComponent(id)}`)) as OrderDetail;
export const recordOrderPayment = async (c: BchatClient, ticker: string, id: string, txid: string) =>
  c.request('POST', `${path(ticker)}/orders/${encodeURIComponent(id)}`, { txid });
export const cancelOrder = async (c: BchatClient, ticker: string, id: string) =>
  c.request('POST', `${path(ticker)}/orders/${encodeURIComponent(id)}`, { action: 'cancel' });
export const recordRefund = async (c: BchatClient, ticker: string, id: string, txid: string) =>
  c.request('POST', `${path(ticker)}/orders/${encodeURIComponent(id)}`, { action: 'refunded', txid });

/** Record a broadcast payment, retrying a few times: the money has gone, the record must follow. */
export const recordWithRetry = async (fn: () => Promise<unknown>, tries = 4, waitMs = 1500): Promise<boolean> => {
  for (let i = 0; i < tries; i++) {
    try {
      await fn();
      return true;
    } catch {
      if (i < tries - 1) await new Promise((r) => setTimeout(r, waitMs * (i + 1)));
    }
  }
  return false;
};

/** Does the room have a business agent (or could this person set one up)? One GET per room open. */
export const useBusinessPresence = (client: BchatClient, ticker: string, isOwner: boolean) => {
  const [present, setPresent] = useState(false);
  useEffect(() => {
    let live = true;
    getBusiness(client, ticker)
      .then((s) => live && setPresent(!!s.agent || s.canEdit))
      .catch(() => live && setPresent(false));
    return () => {
      live = false;
    };
  }, [client, ticker, isOwner]);
  return present;
};
