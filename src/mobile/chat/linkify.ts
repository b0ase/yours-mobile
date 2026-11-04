/**
 * Links in chat messages. PURE (no DOM, no network): what is a link, what may be opened, and which link (if any) grows
 * a preview under the bubble. The renderer is chat/MessageLinks.tsx.
 *
 * Owner, 4 Nov 2026: a TERRORNODE link posted in a room from the Chrome extension "showed no share card and wasn't even
 * a clickable link". Rules (same as bChatX, bit-sign src/lib/link-preview.ts + components/VideoEmbed.tsx):
 *  - Only http(s) URLs are links. Nothing else is ever an href: no javascript:, data:, file:, intent: or vbscript:,
 *    and no URL with a user:password@ part (https://paypal.com@evil.example reads as PayPal and goes elsewhere).
 *  - The preview link is the first video link, then the first GIPHY link, else the first link (giphyLink.ts).
 *  - End-to-end encrypted rooms never fetch a card: a card is our server fetching (and caching) a URL it was never
 *    meant to see. A GIF or a video there waits for a tap with nothing loaded; any other link is a plain link.
 */
import { parseVideoLink, type VideoLink } from '../feed/video-embed';
import { giphyGif, giphyOnlyMessage, pickPreviewUrl, type GiphyGif } from './giphyLink';
import type { ChatMessage, ChatRoom } from './messages';

/** A bare http(s) URL in message text. Trailing punctuation is left out of the match (bit-sign URL_RE). */
export const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}])/gi;

/** The href to use for a URL found in text, or null when it must not be a link. */
export function safeHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  // Checked on the raw text too: URL() would happily normalise odd inputs.
  if (!/^https?:\/\//i.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  if (!u.hostname || !u.hostname.includes('.')) return null;
  return u.href;
}

/** Every safe http(s) URL in a block of text, de-duplicated, in order of appearance (as written). */
export function extractUrls(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    const u = m[1];
    if (!seen.has(u) && safeHref(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

export type LinkPart = { text: string; href?: string };

/** Split text into plain spans and link spans. A URL that fails safeHref stays plain text. */
export function linkParts(text: string | null | undefined): LinkPart[] {
  const s = text ?? '';
  const out: LinkPart[] = [];
  let at = 0;
  for (const m of s.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    const href = safeHref(m[1]);
    if (!href) continue;
    if (start > at) out.push({ text: s.slice(at, start) });
    out.push({ text: m[1], href });
    at = start + m[1].length;
  }
  if (at < s.length) out.push({ text: s.slice(at) });
  return out;
}

// ── End-to-end encrypted messages (bit-sign docs/E2EE-CHAT.md) ──────────────────────────────

/** A sealed body as bit-sign stores it: `e2ee1:<envelope>`. The wallet can't open these. */
export const isSealedBody = (body: string | null | undefined): boolean => /^e2ee\d+:/.test((body ?? '').trim());

/** A message that was (or is) end-to-end encrypted: a sealed body, or bChatX's `e2ee: true` mark on its payload. */
export const isSealedMessage = (m: Pick<ChatMessage, 'body' | 'event_payload'> | null | undefined): boolean =>
  !!m && (isSealedBody(m.body) || (m.event_payload as { e2ee?: unknown } | null | undefined)?.e2ee === true);

/** An encrypted room: flagged in its metadata, or any message in it is sealed. No previews are fetched there. */
export const roomIsEncrypted = (
  room: Pick<ChatRoom, 'metadata'> | null | undefined,
  messages: readonly Pick<ChatMessage, 'body' | 'event_payload'>[] = [],
): boolean => {
  const meta = (room?.metadata ?? {}) as { e2ee?: unknown; encrypted?: unknown };
  return meta.e2ee === true || meta.encrypted === true || messages.some(isSealedMessage);
};

// ── Which preview a message gets ────────────────────────────────────────────────────────────

export type PreviewPlan =
  | { kind: 'none' }
  /** A GIPHY link: the GIF from i.giphy.com. `sealed`: nothing loads until the viewer taps. */
  | { kind: 'gif'; gif: GiphyGif; url: string; sealed: boolean; only: boolean }
  /** A YouTube / Vimeo / video-file link: click-to-play. `sealed`: nothing loads until the viewer taps. */
  | { kind: 'video'; video: VideoLink; url: string; sealed: boolean }
  /** Any other link: the Open Graph card from bit-sign's unfurl. Never in an encrypted room. */
  | { kind: 'card'; url: string };

/** The preview under a message, or none. `encrypted`: the room is end-to-end encrypted (no card fetch). */
export function previewPlan(body: string | null | undefined, opts: { encrypted: boolean }): PreviewPlan {
  if (isSealedBody(body)) return { kind: 'none' };
  const url = pickPreviewUrl(extractUrls(body));
  if (!url) return { kind: 'none' };
  const gif = giphyGif(url);
  if (gif) return { kind: 'gif', gif, url, sealed: opts.encrypted, only: !!giphyOnlyMessage(body) };
  const video = parseVideoLink(url);
  if (video) return { kind: 'video', video, url, sealed: opts.encrypted };
  return opts.encrypted ? { kind: 'none' } : { kind: 'card', url };
}

/** May this URL be sent to the unfurl API? Never from an encrypted room, never a GIPHY link, only a safe http(s) URL. */
export const shouldUnfurl = (url: string, opts: { encrypted: boolean }): boolean =>
  !opts.encrypted && !!safeHref(url) && !giphyGif(url);

// ── Open Graph cards (bit-sign GET /api/bitsign/unfurl) ─────────────────────────────────────

export type LinkCardData = {
  url: string;
  /** Where the card opens: the page's final URL when it redirected, else the link (always a safe http(s) URL). */
  href: string;
  site: string;
  title: string | null;
  description: string | null;
  /** https images only (no mixed content). */
  image: string | null;
  favicon: string | null;
};

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const httpsOnly = (v: unknown) => {
  const s = str(v);
  return s && /^https:\/\//i.test(s) && safeHref(s) ? s : null;
};
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** bit-sign's `{ previews: [...] }` → the card for `url`, or null when it has nothing worth showing. */
export function parseLinkCard(data: unknown, url: string): LinkCardData | null {
  const list = (data as { previews?: unknown } | null)?.previews;
  if (!Array.isArray(list)) return null;
  const rows = list.filter((p): p is Record<string, unknown> => !!p && typeof p === 'object');
  const p = rows.find((r) => r.url === url) ?? rows[0];
  if (!p || p.ok !== true) return null;
  const title = str(p.title);
  const image = httpsOnly(p.image_url);
  if (!title && !image) return null;
  const href = safeHref(str(p.final_url)) ?? safeHref(url);
  if (!href) return null;
  return {
    url,
    href,
    site: str(p.site_name) ?? hostOf(href),
    title,
    description: str(p.description),
    image,
    favicon: httpsOnly(p.favicon_url),
  };
}

export type UnfurlFetch = (url: string) => Promise<unknown>;

const cards = new Map<string, Promise<LinkCardData | null>>();

/**
 * The card for a link, fetched once per URL per session (a room that re-renders on every poll asks once). The gate
 * comes first: an encrypted room, a GIPHY link or an unsafe URL never reaches `fetchPreviews`.
 */
export function loadLinkCard(
  url: string,
  opts: { encrypted: boolean },
  fetchPreviews: UnfurlFetch,
): Promise<LinkCardData | null> {
  if (!shouldUnfurl(url, opts)) return Promise.resolve(null);
  let p = cards.get(url);
  if (!p) {
    p = fetchPreviews(url).then(
      // A page with no card (`ok: false`) stays a plain link for the session: no retry.
      (data) => parseLinkCard(data, url),
      // A failed request (offline, signed out) may try again the next time the bubble mounts.
      () => {
        cards.delete(url);
        return null;
      },
    );
    cards.set(url, p);
  }
  return p;
}

/** Tests only. */
export const __clearLinkCards = () => cards.clear();
