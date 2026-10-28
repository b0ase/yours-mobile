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

/** The bChatX room page opened on one document, or null for anything that isn't a plain ticker + id. */
export const signDocUrl = (ticker: string, docId: string): string | null => {
  const t = (ticker || '').trim().replace(/^\$/, '').toUpperCase();
  if (!TICKER_RE.test(t) || !ID_RE.test(docId || '')) return null;
  return `https://www.bchatx.com/room/${encodeURIComponent(t)}?doc=${encodeURIComponent(docId)}`;
};

/**
 * Which document the room's banner offers: the one a tapped notification named (it may be newer than the room row the
 * list holds), else the room's pinned pending_doc.
 */
export const docToOffer = (room: Pick<ChatRoom, 'metadata'>, fromPush: string | null): string | null => {
  if (fromPush && ID_RE.test(fromPush)) return fromPush;
  return pendingDocOf(room)?.id ?? null;
};
