/**
 * Video links → click-to-play embeds. PURE and ISOMORPHIC (no DOM, no node builtins).
 *
 * Copied from bit-sign src/lib/video-embed.ts (bChatX feed + rooms). KEEP THE TWO IN STEP.
 * Shared by bWalletX feed posts / replies and chat rooms (bit-sign has the same file
 * at src/lib/video-embed.ts). The renderer (feed/VideoEmbed.tsx) shows the
 * thumbnail and a play button and only creates the iframe when the viewer taps play.
 *
 * Privacy and safety rules live HERE so every surface gets them:
 *  - YouTube plays from youtube-nocookie.com (no cookies until play, and none from us before).
 *  - Vimeo plays with dnt=1.
 *  - Nothing autoplays with sound: the iframe is created by the viewer's tap, so autoplay=1
 *    only starts the video they just asked for.
 *  - Iframes are sandboxed (EMBED_SANDBOX) and lazy.
 *
 * Existing on-chain post formats are unchanged: we only read URLs found in text.
 */

export type VideoProvider = 'youtube' | 'vimeo' | 'file';

export interface VideoLink {
  provider: VideoProvider;
  /** The URL as written (what "open" links to). */
  url: string;
  /** Provider id (YouTube 11-char id, Vimeo number); the URL itself for a file. */
  id: string;
  /** Start offset in seconds, 0 when none. */
  start: number;
  /** YouTube Shorts are portrait. */
  portrait: boolean;
  /** Live stream link (youtube.com/live/…). */
  live: boolean;
}

const YT_HOSTS = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtube-nocookie\.com)$/i;
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const VIDEO_FILE = /\.(mp4|m4v|webm|mov)$/i;

/** "90", "90s", "1m30s", "1h2m3s", "1:30", "01:02:03" → seconds (0 when unreadable). */
export function parseStart(raw: string | null | undefined): number {
  if (!raw) return 0;
  const s = raw.trim().toLowerCase();
  if (/^\d+$/.test(s)) return clampStart(Number(s));
  if (/^\d+(?::\d{1,2}){1,2}$/.test(s)) {
    return clampStart(s.split(':').reduce((acc, p) => acc * 60 + Number(p), 0));
  }
  const m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) return 0;
  return clampStart(Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0));
}
const clampStart = (n: number) => (Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 24 * 3600) : 0);

/** A video link in `raw`, or null. Only http(s); anything odd is null (shown as a plain link). */
export function parseVideoLink(raw: string): VideoLink | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  const hashT = new URLSearchParams(u.hash.replace(/^#/, '')).get('t');
  const start = parseStart(u.searchParams.get('t') ?? u.searchParams.get('start') ?? hashT);

  if (host === 'youtu.be') {
    const id = path.split('/')[1] ?? '';
    return YT_ID.test(id) ? { provider: 'youtube', url: raw, id, start, portrait: false, live: false } : null;
  }
  if (YT_HOSTS.test(host)) {
    let id = '';
    let portrait = false;
    let live = false;
    const seg = path.split('/').filter(Boolean);
    if (path === '/watch') id = u.searchParams.get('v') ?? '';
    else if (seg[0] === 'shorts') {
      id = seg[1] ?? '';
      portrait = true;
    } else if (seg[0] === 'live') {
      id = seg[1] ?? '';
      live = true;
    } else if (seg[0] === 'embed' || seg[0] === 'v') id = seg[1] ?? '';
    return YT_ID.test(id) ? { provider: 'youtube', url: raw, id, start, portrait, live } : null;
  }
  if (host === 'vimeo.com' || host === 'www.vimeo.com' || host === 'player.vimeo.com') {
    const m = path.match(/^\/(?:video\/)?(\d{6,12})(?:\/|$)/);
    return m ? { provider: 'vimeo', url: raw, id: m[1], start, portrait: false, live: false } : null;
  }
  // Direct files: https only (no mixed content), judged by the path's extension.
  if (u.protocol === 'https:' && VIDEO_FILE.test(path)) {
    return { provider: 'file', url: raw, id: raw, start, portrait: false, live: false };
  }
  return null;
}

/** The iframe src for a tap-to-play embed (null for direct files, which use <video>). */
export function embedSrc(v: VideoLink): string | null {
  if (v.provider === 'youtube') {
    const q = new URLSearchParams({ autoplay: '1', rel: '0', modestbranding: '1', playsinline: '1' });
    if (v.start) q.set('start', String(v.start));
    return `https://www.youtube-nocookie.com/embed/${v.id}?${q}`;
  }
  if (v.provider === 'vimeo') {
    return `https://player.vimeo.com/video/${v.id}?autoplay=1&dnt=1${v.start ? `#t=${v.start}s` : ''}`;
  }
  return null;
}

/** Thumbnail known without a fetch (YouTube); others come from the cached unfurl. */
export function knownThumb(v: VideoLink): string | null {
  return v.provider === 'youtube' ? `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg` : null;
}

/** A direct file plays from its own URL, starting at `#t=` when given. */
export function fileSrc(v: VideoLink): string {
  if (!v.start) return v.url;
  return `${v.url.split('#')[0]}#t=${v.start}`;
}

/**
 * Sandbox for provider iframes: scripts + same-origin (the players need their own storage),
 * presentation (fullscreen / PiP), popups so "watch on YouTube" opens a tab. No top navigation,
 * no forms, no downloads.
 */
export const EMBED_SANDBOX =
  'allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox';
export const EMBED_ALLOW = 'autoplay; encrypted-media; picture-in-picture; fullscreen';

export const providerLabel = (p: VideoProvider) => (p === 'youtube' ? 'YouTube' : p === 'vimeo' ? 'Vimeo' : 'Video');

/** "1:05" / "1:02:03" for a start offset. */
export function startLabel(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** The first video link in a block of text (room messages show one player per message). */
export function firstVideoLink(urls: string[]): VideoLink | null {
  for (const u of urls) {
    const v = parseVideoLink(u);
    if (v) return v;
  }
  return null;
}
