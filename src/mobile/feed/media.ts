import { thumbUrl } from '../market/thumbs';

/**
 * Feed media: pure helpers that turn B parts, MAP keys and post text into images, video,
 * audio and link embeds. No network here; FeedMedia.tsx renders the result.
 *
 * Patterns seen live on bmap (Oct 2026 samples):
 *  - bWallet / peck.to: inline B image/jpeg, base64 content.
 *  - Twetch: B image/jpeg|png or video/mp4 with the content STRIPPED by bmap (only
 *    content-type + filename "twetch_twembed….jpg"), text in MAP `comment`. The bytes are the
 *    OP_RETURN's first B part, which ordfs.network serves at <txid>_0.
 *  - Treechat: text/markdown only. Media is linked in the text: 3dordi.io/ordinal/<outpoint>,
 *    ordfs.network/content/<outpoint>, YouTube (youtu.be / youtube.com/watch), other https links.
 *  - Twetch text: YouTube links and direct https .mp4 URLs.
 */
export const ORDFS = 'https://ordfs.network';
export const MAX_MEDIA_PER_POST = 8;
export const MAX_LINK_CARDS = 2;

export type MediaKind = 'image' | 'video' | 'audio';
export type FeedMedia = {
  kind: MediaKind;
  /** Full content (only fetched when shown / played). */
  src: string;
  mime: string;
  /** Small resized image (1sat ORDFS image endpoint) when the media is on-chain; else null. */
  thumb: string | null;
  /** Outpoint (txid_vout) or txid the media lives at, for the safety filter / reports. */
  ref: string | null;
  /** Video poster image URL (inline poster B part), if any. */
  poster?: string | null;
  /** Kind guessed from a link with no mime (e.g. a 3dordi ordinal); renderer may fall back to a card. */
  guessed?: boolean;
};
export type LinkEmbed =
  | { kind: 'youtube'; id: string; url: string; thumb: string }
  | { kind: 'vimeo'; id: string; url: string }
  | { kind: 'link'; url: string; host: string };

const IMAGE_MIME = /^image\/(jpeg|jpg|png|gif|webp|avif)$/;
const VIDEO_MIME = /^video\/(mp4|webm|quicktime)$/;
const AUDIO_MIME = /^audio\/(mpeg|mp3|mp4|x-m4a|aac|ogg|wav|x-wav|wave|webm)$/;

export function kindOf(mime: string): MediaKind | null {
  const m = mime.trim().toLowerCase().split(';')[0];
  if (IMAGE_MIME.test(m)) return 'image';
  if (VIDEO_MIME.test(m)) return 'video';
  if (AUDIO_MIME.test(m)) return 'audio';
  return null;
}

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  wav: 'audio/wav',
};
export const mimeFromPath = (path: string): string | null => {
  const m = path.toLowerCase().match(/\.([a-z0-9]{2,4})$/);
  return (m && EXT_MIME[m[1]]) || null;
};

const TXID = '[0-9a-f]{64}';
/**
 * Outpoint (txid_vout) from any on-chain reference: b://, 1sat://, ord://, bitfs://txid.out.N,
 * a bare txid / outpoint, or ordfs / 1sat content / 3dordi URLs. null if none.
 */
export function refToOutpoint(ref: string): string | null {
  const r = ref.trim();
  let m = r.match(new RegExp(`^(?:b|1sat|ord)://(${TXID})(?:[._](\\d{1,6}))?(?:$|[/?#])`, 'i'));
  if (m) return `${m[1]}_${m[2] ?? '0'}`.toLowerCase();
  m = r.match(new RegExp(`^bitfs://(${TXID})\\.out\\.(\\d{1,6})`, 'i'));
  if (m) return `${m[1]}_${m[2]}`.toLowerCase();
  m = r.match(new RegExp(`^(${TXID})(?:[._](\\d{1,6}))?$`, 'i'));
  if (m) return `${m[1]}_${m[2] ?? '0'}`.toLowerCase();
  m = r.match(
    new RegExp(
      `^https://(?:ordfs\\.network|api\\.1sat\\.app(?:/1sat)?|ordinals\\.gorillapool\\.io|(?:www\\.)?3dordi\\.io)/(?:content/|ordinal/|ordfs/)?(${TXID})(?:[._](\\d{1,6}))?(?:$|[/?#])`,
      'i',
    ),
  );
  if (m) return `${m[1]}_${m[2] ?? '0'}`.toLowerCase();
  return null;
}

/** Full on-chain content for an outpoint. ordfs.network serves both inscriptions and B files. */
export const ordfsUrl = (outpoint: string) => `${ORDFS}/${outpoint}`;

/** A FeedMedia for on-chain content at `outpoint`. */
export function chainMedia(outpoint: string, mime: string, guessed = false): FeedMedia | null {
  const kind = kindOf(mime);
  if (!kind) return null;
  return {
    kind,
    src: ordfsUrl(outpoint),
    mime: mime.toLowerCase(),
    // The resize endpoint only handles images (415 for video), so no thumb for AV.
    thumb: kind === 'image' ? thumbUrl(outpoint) : null,
    ref: outpoint,
    ...(guessed ? { guessed } : {}),
  };
}

const BASE64 = /^[A-Za-z0-9+/=\s]+$/;
const RAW_HTTPS = /^https:\/\/[^\s"'<>]+$/i;

/**
 * One B part → media. `index` is its position among the tx's B parts: bmap strips large
 * content, and only the first B part (index 0) of the OP_RETURN at vout 0 is addressable on ordfs.
 */
export function mediaFromB(
  b: { mime: string; content: string; filename?: string },
  txid: string,
  index: number,
): FeedMedia | null {
  const mime = b.mime.toLowerCase();
  const kind = kindOf(mime);
  if (!kind) return null;
  const content = b.content.trim();
  if (!content) return index === 0 ? chainMedia(`${txid.toLowerCase()}_0`, mime) : null;
  if (content.length > 16 && BASE64.test(content)) {
    return { kind, src: `data:${mime};base64,${content.replace(/\s/g, '')}`, mime, thumb: null, ref: txid };
  }
  const op = refToOutpoint(content);
  if (op) return chainMedia(op, mime);
  if (RAW_HTTPS.test(content)) return { kind, src: content, mime, thumb: null, ref: null };
  return null;
}

export const isPosterName = (filename?: string) => !!filename && /^poster[._-]/i.test(filename);

/** MAP media_<n> = "<outpoint>|<mime>", written by bWallet for media inscribed as 1Sat ordinals. */
export function mediaFromMap(map: Record<string, unknown>): FeedMedia[] {
  const out: FeedMedia[] = [];
  for (const [k, v] of Object.entries(map)) {
    if (!/^media_\d{1,2}$/.test(k) || typeof v !== 'string') continue;
    const [ref, mime] = v.split('|');
    const op = refToOutpoint(ref ?? '');
    const m = op && mime ? chainMedia(op, mime) : null;
    if (m) out.push(m);
  }
  return out;
}

const YT =
  /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i;
const VIMEO = /^https?:\/\/(?:www\.|player\.)?vimeo\.com\/(?:video\/)?(\d{6,12})/i;

export function linkEmbed(url: string): LinkEmbed | null {
  const y = url.match(YT);
  if (y) return { kind: 'youtube', id: y[1], url, thumb: `https://i.ytimg.com/vi/${y[1]}/mqdefault.jpg` };
  const v = url.match(VIMEO);
  if (v) return { kind: 'vimeo', id: v[1], url };
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return { kind: 'link', url, host: u.hostname.replace(/^www\./, '') };
  } catch {
    return null;
  }
}

const URL_RE = /(?:https?|b|1sat|ord|bitfs):\/\/[^\s<>"'`)\]]+/gi;
const MD_IMAGE = /!\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/g;
const trimUrl = (u: string) => u.replace(/[.,;:!?…'"）！。]+$/u, '');

/**
 * Media and links referenced in post text (Treechat markdown, Twetch plain text):
 * markdown images, b:// / 1sat:// / bitfs refs, ordfs / 3dordi ordinal links, direct media
 * file URLs → media; YouTube / Vimeo → embeds; other http(s) → link cards. Markdown image
 * syntax is removed from the returned text (it is shown as media instead).
 */
export function mediaFromText(text: string): { text: string; media: FeedMedia[]; links: LinkEmbed[] } {
  const media: FeedMedia[] = [];
  const links: LinkEmbed[] = [];
  const seen = new Set<string>();
  const add = (raw: string, fromMdImage: boolean) => {
    const url = trimUrl(raw);
    if (seen.has(url)) return;
    seen.add(url);
    const op = refToOutpoint(url);
    if (op) {
      const mime = mimeFromPath(url) ?? (fromMdImage ? 'image/jpeg' : null);
      // ordfs / 3dordi links carry no type; guess image (most ordinals) and let the view fall back.
      const m = mime ? chainMedia(op, mime) : chainMedia(op, 'image/webp', true);
      if (m && !media.some((x) => x.ref === op)) media.push(m);
      return;
    }
    if (!/^https?:\/\//i.test(url)) return;
    const mime = mimeFromPath(url.split(/[?#]/)[0]);
    if (/^https:/i.test(url) && (mime || fromMdImage)) {
      const m = kindOf(mime ?? 'image/jpeg');
      if (m) media.push({ kind: m, src: url, mime: mime ?? 'image/jpeg', thumb: null, ref: null });
      return;
    }
    const e = linkEmbed(url);
    if (e) links.push(e);
  };
  const stripped = text.replace(MD_IMAGE, (_all, u: string) => {
    add(u, true);
    return '';
  });
  for (const u of stripped.match(URL_RE) ?? []) add(u, false);
  // Prefer rich embeds; plain link cards only up to the cap.
  const rich = links.filter((l) => l.kind !== 'link');
  const plain = links.filter((l) => l.kind === 'link').slice(0, Math.max(0, MAX_LINK_CARDS - rich.length));
  return { text: stripped.replace(/\n{3,}/g, '\n\n').trim(), media, links: [...rich, ...plain] };
}

/** Merge media lists, dropping repeats (same ref or same src), capped. */
export function dedupeMedia(list: FeedMedia[]): FeedMedia[] {
  const seen = new Set<string>();
  const out: FeedMedia[] = [];
  for (const m of list) {
    const k = m.ref && !m.src.startsWith('data:') ? m.ref : m.src.slice(0, 200);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out.slice(0, MAX_MEDIA_PER_POST);
}

/** Everything the safety filter should see for a post's media (ids + URLs as text). */
export function mediaSafety(media: FeedMedia[], links: LinkEmbed[] = []): { ids: string[]; texts: string[] } {
  const ids: string[] = [];
  const texts: string[] = [];
  for (const m of media) {
    if (m.ref) {
      ids.push(m.ref);
      if (m.ref.includes('_')) ids.push(m.ref.split('_')[0]);
    }
    if (!m.src.startsWith('data:')) texts.push(m.src);
  }
  for (const l of links) texts.push(l.url);
  return { ids, texts };
}

// ── posting ──────────────────────────────────────────────────────────────────
/** AV files at or under this go inline as B; bigger ones are inscribed as 1Sat ordinals first. */
export const MAX_INLINE_AV_BYTES = 100 * 1024;
/** Upper limit for an inscribed video / audio file. */
export const MAX_INSCRIBED_AV_BYTES = 10 * 1024 * 1024;
export const MAX_POST_IMAGES = 4;
/** Total inline bytes per post (images + small AV + poster). */
export const MAX_INLINE_TOTAL_BYTES = 1024 * 1024;

export type AvPlan = { mode: 'inline' } | { mode: 'inscribe' } | { mode: 'reject'; message: string };
export function planAv(bytes: number, mime: string): AvPlan {
  const k = kindOf(mime);
  if (k !== 'video' && k !== 'audio')
    return { mode: 'reject', message: 'Video must be MP4, WebM or MOV; audio MP3, M4A, OGG or WAV.' };
  if (bytes <= 0) return { mode: 'reject', message: 'That file is empty.' };
  if (bytes > MAX_INSCRIBED_AV_BYTES)
    return { mode: 'reject', message: `That file is over ${MAX_INSCRIBED_AV_BYTES / 1024 / 1024} MB. Trim it first.` };
  return bytes <= MAX_INLINE_AV_BYTES ? { mode: 'inline' } : { mode: 'inscribe' };
}
