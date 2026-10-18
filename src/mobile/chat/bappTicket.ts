/**
 * The bApp room penny ticket (bappRooms.ts): what bit-sign's /rooms/[ticker]/ticket answers, the wallet's own
 * checks before paying, and the two outputs it sends. bWalletX only: imported by the lazy ticket sheet, never by
 * a store build (paid entry is a digital sale there, storeBuild.ts).
 */
const norm = (t: string | null | undefined) => (t ?? '').replace(/^\$/, '').toUpperCase();

export interface TicketPay {
  address: string;
  sats: number;
  data: string[];
  reference: string;
  paymail?: string;
}
export interface TicketCard {
  room: {
    ticker: string;
    name: string | null;
    description: string | null;
    icon: string | null;
    official: boolean;
    members: number | null;
    /** Free to walk in (join_mode open): join, no ticket. */
    open_join?: boolean;
  };
  member: boolean;
  ticket: { usd: number; sats: number | null; payee: string | null; ready: boolean; pay: TicketPay | null } | null;
}

const P2PKH = /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/;
/** A ticket is penny-scale: refuse anything above this whatever the server says. */
export const TICKET_MAX_USD = 0.25;
const hexOf = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');
export const ticketReference = (ticker: string, handle: string) =>
  `bwx-ticket:${norm(ticker)}:${handle.replace(/^[$@]/, '').toLowerCase()}`;

export const parseTicketCard = (raw: unknown): TicketCard | null => {
  const r = raw as Partial<TicketCard> | null;
  if (!r || typeof r !== 'object' || !r.room || typeof r.room.ticker !== 'string') return null;
  return { room: r.room, member: r.member === true, ticket: r.ticket ?? null };
};

export type TicketCheck = { ok: true; pay: TicketPay; usd: number } | { ok: false; why: string };

/** Defence in depth: the wallet pays only a penny-scale ticket, for me, to this room, with my reference. */
export const checkTicket = (card: TicketCard | null, ticker: string, me: string): TicketCheck => {
  if (!card) return { ok: false, why: 'Room not found' };
  if (norm(card.room.ticker) !== norm(ticker)) return { ok: false, why: 'Room mismatch; not paying' };
  const t = card.ticket;
  if (!t) return { ok: false, why: 'This room doesn’t sell tickets yet' };
  if (!t.pay || !t.ready) return { ok: false, why: 'Tickets aren’t on sale right now. Try again soon.' };
  if (!(t.usd > 0) || t.usd > TICKET_MAX_USD) return { ok: false, why: 'The ticket price looks wrong; not paying' };
  const p = t.pay;
  if (!P2PKH.test(p.address)) return { ok: false, why: 'The payment address looks wrong; not paying' };
  if (!Number.isInteger(p.sats) || p.sats <= 0 || p.sats !== t.sats)
    return { ok: false, why: 'The amount looks wrong; not paying' };
  const ref = ticketReference(ticker, me);
  if (p.reference !== ref || p.data.length !== 1 || p.data[0] !== hexOf(ref))
    return { ok: false, why: 'The ticket reference is wrong; not paying' };
  return { ok: true, pay: p, usd: t.usd };
};

/** The two outputs: the room's payee, and my ticket reference (so the payment is provably mine). */
export const ticketRequests = (p: TicketPay) => [
  { address: p.address, satoshis: p.sats },
  { satoshis: 0, data: p.data },
];

/** "Enter · 1p" in the user's words: pennies under £/$1. */
export const ticketLabel = (usd: number | null | undefined) =>
  `Enter · ${usd && usd >= 0.995 ? `$${usd.toFixed(2)}` : `${Math.max(1, Math.round((usd ?? 0.01) * 100))}p`}`;

// ── bit-sign client (same shape as exchange/curveSales.ts) ──

const BITSIGN = 'https://www.bit-sign.online';
type F = typeof fetch;
const authHeaders = (token: string | null | undefined): Record<string, string> =>
  token ? { Authorization: `Bearer ${token}` } : {};
const ticketUrl = (ticker: string) => `${BITSIGN}/api/bitsign/rooms/${encodeURIComponent(norm(ticker))}/ticket`;

/** The room card + my ticket's pay spec (signed in). Null when the room isn't there. */
export const fetchTicketCard = async (
  ticker: string,
  token: string | null,
  f: F = fetch,
): Promise<TicketCard | null> => {
  const r = await f(ticketUrl(ticker), { headers: authHeaders(token), credentials: 'omit' });
  if (r.status === 404) return null;
  const body = (await r.json().catch(() => null)) as unknown;
  if (!r.ok) throw new Error((body as { error?: string } | null)?.error || `HTTP ${r.status}`);
  return parseTicketCard(body);
};

/** Record my ticket payment. The tx can take a moment to reach the indexer: retry "not on chain yet" (409/503). */
export const recordTicket = async (
  ticker: string,
  txid: string,
  token: string | null,
  f: F = fetch,
  tries = 6,
  waitMs = 2500,
): Promise<{ ok: boolean; error?: string }> => {
  for (let i = 0; ; i++) {
    const r = await f(ticketUrl(ticker), {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify({ txid }),
    }).catch(() => null);
    const body = ((await r?.json().catch(() => null)) ?? {}) as { ok?: boolean; error?: string };
    if (r?.ok && body.ok) return { ok: true };
    const retry = !r || r.status === 409 || r.status === 503;
    if (!retry || i >= tries - 1) return { ok: false, error: body.error || 'Could not record the ticket' };
    await new Promise((res) => setTimeout(res, waitMs));
  }
};
