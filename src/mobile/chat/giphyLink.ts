/**
 * GIPHY links → the GIF itself. PURE (no DOM).
 *
 * Copied from bit-sign src/lib/giphy-link.ts (bChatX rooms, 4 Nov 2026). KEEP THE TWO IN STEP, so a GIF sent from
 * bChatX or the wallet draws the same in both.
 *
 * Why: a pasted media0.giphy.com/…/giphy.gif link showed as the raw URL plus GIPHY's Open Graph text card, because the
 * unfurl fetched the media URL and got GIPHY's HTML page back. "A GIPHY GIF should just show the GIF." Every GIPHY URL
 * shape is reduced to its id and redrawn from one fixed address, https://i.giphy.com/<id>.gif: no tracking parameters,
 * no "v1.<base64>" analytics segment, and no host the poster chose. Anything that is not exactly a GIPHY host over https
 * is null and stays a plain link.
 */
import { parseVideoLink } from '../feed/video-embed';

export interface GiphyGif {
  /** GIPHY's id, e.g. "juqBfGDqu981ZSELSQ". */
  id: string;
  /** The image we draw: https://i.giphy.com/<id>.gif. */
  src: string;
  /** Where tapping the GIF goes: https://giphy.com/gifs/<id>. */
  page: string;
}

const ID = /^[A-Za-z0-9]{6,40}$/;
/** giphy.com pages. */
const PAGE_HOSTS = new Set(['giphy.com', 'www.giphy.com']);
/** The CDN: media.giphy.com, media0–4.giphy.com and i.giphy.com. */
const MEDIA_HOST = /^(?:media[0-4]?|i)\.giphy\.com$/;
/** The analytics segment the API puts before the id: /media/v1.Y2lkPW…/<id>/giphy.gif. */
const V1_SEGMENT = /^v1\.[A-Za-z0-9_=-]+$/;
/** giphy.gif, 200.gif, 200w.webp, giphy-downsized.gif, giphy.mp4 … */
const MEDIA_FILE = /^[A-Za-z0-9_-]+\.(?:gif|webp|mp4)$/i;

const gifOf = (id: string): GiphyGif | null =>
  ID.test(id) ? { id, src: `https://i.giphy.com/${id}.gif`, page: `https://giphy.com/gifs/${id}` } : null;

/** The GIF a GIPHY URL points at, or null for anything else (a look-alike host, http:, a search page …). */
export function giphyGif(raw: string | null | undefined): GiphyGif | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  // https only (no mixed content), no credentials or odd ports: a GIPHY link has none of them.
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);

  if (PAGE_HOSTS.has(host)) {
    // /gifs/<slug>-<id>, /gifs/<id>, /stickers/<slug>-<id>, /embed/<id>
    if (seg.length !== 2) return null;
    if (seg[0] === 'embed') return gifOf(seg[1]);
    if (seg[0] === 'gifs' || seg[0] === 'stickers') return gifOf(seg[1].split('-').pop() ?? '');
    return null;
  }
  if (MEDIA_HOST.test(host)) {
    // i.giphy.com/<id>.gif
    if (host === 'i.giphy.com' && seg.length === 1) {
      const m = seg[0].match(/^([A-Za-z0-9]+)\.(?:gif|webp)$/i);
      return m ? gifOf(m[1]) : null;
    }
    // /media/<id>/<file>  or  /media/v1.<…>/<id>/<file>
    if (seg[0] !== 'media') return null;
    const rest = seg.length === 4 && V1_SEGMENT.test(seg[1]) ? seg.slice(2) : seg.slice(1);
    if (rest.length !== 2 || !MEDIA_FILE.test(rest[1])) return null;
    return gifOf(rest[0]);
  }
  return null;
}

/**
 * A GIF-only message: its whole text (trimmed) is one GIPHY URL and nothing else. The bubble then shows just the GIF,
 * with no URL text above it. Anything more (a word, a second link) keeps its text and shows the GIF under it.
 */
export function giphyOnlyMessage(text: string | null | undefined): GiphyGif | null {
  const t = (text ?? '').trim();
  if (!t || /\s/.test(t)) return null;
  return giphyGif(t);
}

/** What a list line, reply quote or notification says for a message: "GIF" for a GIF-only one, else its text. */
export const GIF_LABEL = 'GIF';
export function gifOrText(text: string | null | undefined): string {
  return giphyOnlyMessage(text) ? GIF_LABEL : (text ?? '');
}

/**
 * Which of a message's links gets the preview under it: the first video link, then the first GIPHY link, else the
 * first link. A GIPHY .mp4 counts as a GIF, not a video.
 */
export function pickPreviewUrl(urls: string[]): string | null {
  return urls.find((u) => parseVideoLink(u) && !giphyGif(u)) ?? urls.find((u) => giphyGif(u)) ?? urls[0] ?? null;
}
