/**
 * Public podcast episodes from RSS (Feed › bRadio › Podcasts). Pure parsers are tested in
 * rssPodcasts.test.ts. Phones read feeds via native HTTP; web/desktop use fetch (every listed
 * feed sends CORS *). Results are cached for 30 min in memory and localStorage.
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { decodeEntities } from '../feed/bnews';
import { PODCAST_SHOWS, type PodcastShow } from './podcastFeeds';

export type PodcastEpisode = {
  id: string;
  showId: string;
  showName: string;
  homepage: string;
  title: string;
  /** https audio enclosure on the publisher's host. */
  audio: string;
  /** https art (episode, else show), or null. */
  image: string | null;
  /** Published time, ms (0 when unknown). */
  at: number;
  /** Seconds (0 when unknown). */
  duration: number;
};

const textOf = (raw: string): string =>
  decodeEntities(raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

const tag = (block: string, name: string): string | null => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : null;
};

const attr = (el: string, name: string): string | null => {
  const m = el.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? decodeEntities(m[2] ?? m[3] ?? '') : null;
};

const https = (u: string | null): string | null => {
  if (!u) return null;
  try {
    const url = new URL(u.trim());
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
};

/** itunes:duration as seconds: "1:02:03", "62:03", "3723" (non-numeric → 0). */
export function parseDuration(raw: string | null): number {
  if (!raw) return 0;
  const s = textOf(raw);
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(s)) return 0;
  return Math.round(s.split(':').reduce((acc, p) => acc * 60 + parseFloat(p), 0));
}

/** "1 h 5 min", "42 min", "45 s"; '' when unknown. */
export function formatDuration(sec: number): string {
  if (!sec || sec < 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h) return m ? `${h} h ${m} min` : `${h} h`;
  return m ? `${m} min` : `${sec} s`;
}

const imageOf = (block: string): string | null => {
  const it = block.match(/<itunes:image\b[^>]*>/i);
  if (it) {
    const u = https(attr(it[0], 'href'));
    if (u) return u;
  }
  const img = tag(block, 'image');
  const u = img ? tag(img, 'url') : null;
  return u ? https(textOf(u)) : null;
};

/** Episodes with an https audio enclosure, newest first. */
export function parsePodcastRss(xml: string, show: PodcastShow, limit = 3): PodcastEpisode[] {
  if (typeof xml !== 'string' || !/<rss\b/i.test(xml)) return [];
  const head = xml.split(/<item\b/i)[0];
  const showArt = imageOf(head);
  const out: PodcastEpisode[] = [];
  for (const b of xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? []) {
    const enc = (b.match(/<enclosure\b[^>]*>/gi) ?? []).find((e) => /^audio\//i.test(attr(e, 'type') ?? 'audio/'));
    const audio = https(enc ? attr(enc, 'url') : null);
    const t = tag(b, 'title');
    const title = t ? textOf(t).slice(0, 200) : '';
    if (!audio || !title) continue;
    const pub = tag(b, 'pubDate');
    const at = pub ? Date.parse(textOf(pub)) : NaN;
    const guid = tag(b, 'guid');
    out.push({
      id: `${show.id}:${guid ? textOf(guid) : audio}`,
      showId: show.id,
      showName: show.name,
      homepage: show.homepage,
      title,
      audio,
      image: imageOf(b) ?? showArt,
      at: Number.isFinite(at) ? at : 0,
      duration: parseDuration(tag(b, 'itunes:duration')),
    });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}

/** Newest first across shows, at most `perShow` each, `max` in all. */
export function mergeEpisodes(lists: PodcastEpisode[][], perShow = 2, max = 12): PodcastEpisode[] {
  return lists
    .flatMap((l) => l.slice(0, perShow))
    .sort((a, b) => b.at - a.at)
    .slice(0, max);
}

// ── cache ────────────────────────────────────────────────────────────────────

export const CACHE_KEY = 'bwallet.bradio.rss';
export const CACHE_MS = 30 * 60_000;
type Cached = { at: number; items: PodcastEpisode[] };
let memo: Cached | null = null;

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const store = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

export function readCache(now = Date.now(), s: Store | null = store()): PodcastEpisode[] | null {
  if (memo && now - memo.at < CACHE_MS) return memo.items;
  try {
    const c = JSON.parse(s?.getItem(CACHE_KEY) ?? 'null') as Cached | null;
    if (c && typeof c.at === 'number' && Array.isArray(c.items) && now - c.at < CACHE_MS) {
      memo = c;
      return c.items;
    }
  } catch {
    // bad or unavailable storage
  }
  return null;
}

export function writeCache(items: PodcastEpisode[], now = Date.now(), s: Store | null = store()) {
  memo = { at: now, items };
  try {
    s?.setItem(CACHE_KEY, JSON.stringify(memo));
  } catch {
    // storage unavailable
  }
}

// ── fetching ─────────────────────────────────────────────────────────────────

export type FetchText = (url: string) => Promise<string | null>;

const nativeText: FetchText = async (url) => {
  const r = await CapacitorHttp.request({ method: 'GET', url, headers: {}, responseType: 'text' });
  return r.status === 200 && typeof r.data === 'string' ? r.data : null;
};

const webText: FetchText = async (url) => {
  const r = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(15_000) });
  return r.ok ? r.text() : null;
};

/** Recent episodes from every listed show; failed feeds are skipped. Empty when all fail. */
export async function fetchPublicEpisodes(
  get: FetchText = Capacitor.isNativePlatform() ? nativeText : webText,
  shows: PodcastShow[] = PODCAST_SHOWS,
): Promise<PodcastEpisode[]> {
  const cached = readCache();
  if (cached) return cached;
  const lists = await Promise.all(
    shows.map((s) =>
      get(s.rss)
        .then((xml) => (xml ? parsePodcastRss(xml, s) : []))
        .catch(() => []),
    ),
  );
  const items = mergeEpisodes(lists);
  if (items.length) writeCache(items);
  return items;
}
