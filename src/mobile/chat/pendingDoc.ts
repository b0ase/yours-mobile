/**
 * A document waiting for signature in a bChatX room (bit-sign pins it as room metadata.pending_doc when a file is
 * made signable). PURE: pendingDoc.test.ts imports it directly.
 *
 * The wallet has no signing panel for room documents yet, so "Review & sign" opens the room's bChatX page on that
 * document (www.bchatx.com/room/<TICKER>?doc=<id>), which reads it, signs with the wallet and seals. The URL is
 * always rebuilt here from the ticker and id; nothing a server or push sent is ever opened as a URL.
 */
import type { ChatRoom } from './messages';

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const TICKER_RE = /^[A-Z0-9_.-]{1,64}$/;

export type PendingDoc = { id: string; sentBy: string | null; sentAt: string | null };

export const pendingDocOf = (room: Pick<ChatRoom, 'metadata'> | null | undefined): PendingDoc | null => {
  const p = (room?.metadata as { pending_doc?: unknown } | null | undefined)?.pending_doc as
    | { id?: unknown; sent_by?: unknown; sent_at?: unknown }
    | null
    | undefined;
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !ID_RE.test(p.id)) return null;
  return {
    id: p.id,
    sentBy: typeof p.sent_by === 'string' ? p.sent_by : null,
    sentAt: typeof p.sent_at === 'string' ? p.sent_at : null,
  };
};

/**
 * The bChatX room page opened on one document, or null for anything that isn't a plain ticker + id. With the
 * document's sha256 (from a scanned "Sign on your phone" QR, chat/signLink.ts) it is bChatX's phone-sign page
 * (?sign=&h=), which recomputes the hash and refuses on a mismatch before offering to sign.
 */
export const signDocUrl = (ticker: string, docId: string, hash?: string | null): string | null => {
  const t = (ticker || '').trim().replace(/^\$/, '').toUpperCase();
  if (!TICKER_RE.test(t) || !ID_RE.test(docId || '')) return null;
  const base = `https://www.bchatx.com/room/${encodeURIComponent(t)}`;
  const h = (hash || '').toLowerCase();
  if (/^[0-9a-f]{64}$/.test(h)) return `${base}?sign=${encodeURIComponent(docId)}&h=${h}`;
  return `${base}?doc=${encodeURIComponent(docId)}`;
};

/**
 * Which document the room's banner offers: the one a tapped notification named (it may be newer than the room row the
 * list holds), else the room's pinned pending_doc.
 */
export const docToOffer = (room: Pick<ChatRoom, 'metadata'>, fromPush: string | null): string | null => {
  if (fromPush && ID_RE.test(fromPush)) return fromPush;
  return pendingDocOf(room)?.id ?? null;
};

/**
 * Offer-first room contracts (bit-sign lib/room-offer.ts, owner 28 Oct 2026): an unsigned contract is only a draft;
 * the sender signs it to make an offer; the recipient accepts, rejects or counters. bit-sign mirrors the state onto
 * metadata.pending_doc.offer. The wallet shows the same words as bChatX; the acts happen on bChatX (it signs).
 */
export type OfferStatus = 'draft' | 'offering' | 'offered' | 'accepting' | 'accepted' | 'rejected' | 'superseded';
export type PendingOffer = {
  status: OfferStatus;
  from: string | null;
  to: string[];
  reason: string | null;
  roles: Record<string, string>;
};

const STATUSES: OfferStatus[] = ['draft', 'offering', 'offered', 'accepting', 'accepted', 'rejected', 'superseded'];
const norm = (h: unknown) =>
  String(h ?? '')
    .trim()
    .replace(/^\$/, '')
    .toLowerCase();

export const pendingOfferOf = (room: Pick<ChatRoom, 'metadata'> | null | undefined): PendingOffer | null => {
  const o = (
    (room?.metadata as { pending_doc?: { offer?: unknown } } | null | undefined)?.pending_doc as
      | { offer?: unknown }
      | undefined
  )?.offer as Record<string, unknown> | null | undefined;
  if (!o || typeof o !== 'object' || !STATUSES.includes(o.status as OfferStatus)) return null;
  const roles: Record<string, string> = {};
  if (o.roles && typeof o.roles === 'object') {
    for (const [k, v] of Object.entries(o.roles as Record<string, unknown>)) {
      if (typeof v === 'string') roles[norm(k)] = v.slice(0, 40);
    }
  }
  return {
    status: o.status as OfferStatus,
    from: o.from ? norm(o.from) : null,
    to: Array.isArray(o.to) ? o.to.map(norm).filter(Boolean) : [],
    reason: typeof o.reason === 'string' ? o.reason.slice(0, 500) : null,
    roles,
  };
};

const who = (h: string, roles: Record<string, string>) =>
  roles[h] && roles[h] !== 'Party' ? `$${h} (${roles[h]})` : `$${h}`;
const names = (hs: string[], roles: Record<string, string>) => {
  const xs = hs.map((h) => who(h, roles));
  return xs.length <= 1 ? xs[0] || '' : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
};

export type OfferBanner = { title: string; line: string; youAre: string | null; button: string | null };

/** The banner for this viewer. The sender and the recipient see different words, as on bChatX. */
export const offerBanner = (o: PendingOffer, viewer: string): OfferBanner => {
  const me = norm(viewer);
  const role = o.roles[me];
  const youAre = role && role !== 'Party' ? `You are the ${role}` : null;
  const signers = Object.keys(o.roles);
  switch (o.status) {
    case 'draft':
    case 'offering':
      return {
        title: 'Draft, not an offer',
        line: 'Comment or ask b for changes. To make it an offer, sign it and send it.',
        youAre,
        button: signers.includes(me) && o.status === 'draft' ? 'Sign & send as offer' : null,
      };
    case 'offered':
    case 'accepting':
      if (me === o.from) {
        return {
          title: `Offer sent to ${names(o.to, o.roles)}`,
          line: `Waiting for ${o.to.length > 1 ? 'their signatures' : 'their signature'}.`,
          youAre,
          button: null,
        };
      }
      return {
        title: `Offer from ${who(o.from || '', o.roles)}`,
        line: o.to.includes(me) ? 'Accept, reject or counter on bChatX.' : `Waiting for ${names(o.to, o.roles)}.`,
        youAre,
        button: o.to.includes(me) && o.status === 'offered' ? 'Accept, reject or counter' : null,
      };
    case 'accepted':
      return { title: 'Signed and sealed', line: `Signed by ${names(signers, o.roles)}.`, youAre, button: null };
    case 'rejected':
      return {
        title: 'Offer rejected',
        line: o.reason ? `Reason: ${o.reason}` : 'No reason given.',
        youAre,
        button: null,
      };
    case 'superseded':
      return { title: 'Superseded', line: 'Replaced by a counter-offer.', youAre, button: null };
  }
};
