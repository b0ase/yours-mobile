import { mediaFromText } from './media';
import { isTxid, MAX_POST_CHARS, shortAddress, type FeedPost } from './post';
import { isP2pkhAddress } from './tip';

/**
 * Peck (peck.to) — read through its public overlay, overlay.peck.to (overlay.social).
 *
 * On chain a Peck post is plain Bitcoin Schema: B (text/markdown, post.md) + MAP
 * `SET app=peck.to type=post` (replies add `context=tx tx=<parent>`) + AIP. The overlay
 * indexes it (and the rest of the BSV social network) to the current block:
 *   GET https://overlay.peck.to/v1/feed?app=peck.to&limit=N&offset=M   (CORS *, newest first)
 * → { status, total, data: [{ txid, app, type, content, author, aip_verified, parent_txid,
 *     thread_root_tx, timestamp, reply_count, like_count, … }] }
 *
 * ⚠ The overlay can emit raw control characters inside JSON strings, which JSON.parse
 * rejects — `parsePeckBody` strips them first.
 *
 * Payability: the author is the AIP signing address, and only when the overlay verified the
 * AIP signature (`aip_verified`). Anything else gets a `peck:` key — never a P2PKH address, so
 * tip.payDestination refuses it (no paying an address we cannot tie to the author).
 */
export const PECK_OVERLAY = 'https://overlay.peck.to';
/** The MAP app values read as Peck posts (agents / seeded corpora excluded). */
export const PECK_READ_APPS = ['peck.to'] as const;

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const asStr = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/** Response text → JSON, tolerating raw control characters (they become spaces). */
export function parsePeckBody(text: string): unknown {
  // Matching raw control characters is the point of this regex.
  // eslint-disable-next-line no-control-regex
  return JSON.parse(text.replace(/[\u0000-\u001f]/g, ' '));
}

export function parsePeckItem(item: unknown): FeedPost | null {
  const p = asRec(item);
  const txid = asStr(p.txid).toLowerCase();
  const type = asStr(p.type);
  if (!isTxid(txid) || (type !== 'post' && type !== 'reply')) return null;
  const app = asStr(p.app).trim();
  if (!app.toLowerCase().startsWith('peck')) return null;
  const mime = asStr(p.media_type).toLowerCase();
  const raw = asStr(p.content);
  if (mime && !mime.startsWith('text/')) return null; // image bodies arrive as "HEX:…"
  if (/^HEX:/i.test(raw)) return null;
  const fromText = mediaFromText(raw.trim());
  if (!fromText.text && !fromText.media.length) return null;
  const signer = asStr(p.author);
  const verified = p.aip_verified === true && isP2pkhAddress(signer);
  const parent = asStr(p.parent_txid).toLowerCase();
  const at = Date.parse(asStr(p.timestamp));
  return {
    txid,
    text: fromText.text.slice(0, MAX_POST_CHARS * 2),
    images: [],
    media: fromText.media,
    links: fromText.links,
    app,
    source: 'peck',
    threadId: null,
    replyTo: isTxid(parent) ? parent : null,
    author: {
      address: verified ? signer : `peck:${signer.slice(0, 80)}`,
      bapId: null,
      name: asStr(p.display_name).trim().slice(0, 60) || (signer ? shortAddress(signer) : 'Peck user'),
      avatar: null,
    },
    at: Number.isFinite(at) ? at : 0,
    likes: Number(p.like_count) || 0,
    replies: Number(p.reply_count) || 0,
  };
}

/** An overlay /v1/feed body → Peck posts (reposts, images and non-Peck apps dropped). */
export function parsePeckFeed(body: unknown): FeedPost[] {
  const data = asRec(body).data;
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const out: FeedPost[] = [];
  for (const item of data) {
    const p = parsePeckItem(item);
    if (p && !seen.has(p.txid)) { seen.add(p.txid); out.push(p); }
  }
  return out;
}
