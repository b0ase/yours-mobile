/**
 * Media releases (owner, 12 Oct 2026): music / video published from Media › Add a release.
 *
 * On chain a release is: one inscription per track (audio/video, MAP app=bwallet-media type=track), then the
 * release itself, which is the square cover image inscribed with MAP app=bwallet-media type=release and the
 * release fields (artist, name, genre, ai, tracks). The release origin is the cover's origin (`cover` repeats it
 * as "self" so a reader never needs a second lookup). The Media shelves read releases from GorillaPool's MAP
 * search, newest first, like bPics (bpics/bpics.ts). Covers are raster images shown with <img>; tracks are audio
 * or video shown with <audio>/<video>. HTML, SVG and anything else are dropped, never rendered.
 * No sale path exists for releases yet, so every release is free to listen to.
 */
import { contentUrls } from '../../market/indexer';

export const MEDIA_APP = 'bwallet-media';
export const RELEASE_TYPE = 'release';
export const TRACK_TYPE = 'track';
export const GP_API = 'https://ordinals.gorillapool.io/api';
export const PAGE_SIZE = 30;
export const MAX_TRACKS = 20;
export const COVER_EDGE = 1000;
export const RIGHTS_NOTE = 'Only publish music and video you have the rights to sell.';

const OUTPOINT = /^[0-9a-f]{64}_\d{1,6}$/i;
const SAFE_IMAGE = /^image\/(png|jpe?g|gif|webp|avif)$/i;
const SAFE_TRACK = /^(audio\/(mpeg|mp3|mp4|aac|wav|x-wav|ogg|flac|webm)|video\/(mp4|webm|quicktime))$/i;
export const isSafeCoverType = (t: unknown) => typeof t === 'string' && SAFE_IMAGE.test(t.trim());
export const isSafeTrackType = (t: unknown) => typeof t === 'string' && SAFE_TRACK.test(t.split(';')[0].trim());
export const trackKind = (contentType: string): 'music' | 'video' =>
  /^video\//i.test(contentType) ? 'video' : 'music';

export type TrackRef = { origin: string; title: string; contentType: string };
export type ReleaseFields = {
  title: string;
  artist: string;
  genre: string;
  description: string;
  ai: boolean;
};

const clean = (s: string, max: number) => s.replace(/\s+/g, ' ').trim().slice(0, max);

/** MAP for one track inscription. */
export function buildTrackMap(f: { title: string; artist: string }): Record<string, string> {
  return { app: MEDIA_APP, type: TRACK_TYPE, name: clean(f.title, 100), artist: clean(f.artist, 100) };
}

/** MAP for the release (cover) inscription. `tracks` is JSON: [{o: origin, t: title, k: content type}]. */
export function buildReleaseMap(f: ReleaseFields, tracks: TrackRef[]): Record<string, string> {
  const map: Record<string, string> = {
    app: MEDIA_APP,
    type: RELEASE_TYPE,
    name: clean(f.title, 100),
    artist: clean(f.artist, 100),
    ai: f.ai ? 'true' : 'false',
    cover: 'self',
    tracks: JSON.stringify(tracks.map((t) => ({ o: t.origin, t: clean(t.title, 100), k: t.contentType }))),
  };
  const g = clean(f.genre, 40);
  if (g) map.genre = g;
  const d = f.description.trim().slice(0, 1000);
  if (d) map.description = d;
  return map;
}

export function validateRelease(f: ReleaseFields, trackCount: number, hasCover: boolean): string | null {
  if (!hasCover) return 'Choose a square cover.';
  if (!trackCount) return 'Add at least one audio or video file.';
  if (trackCount > MAX_TRACKS) return `Up to ${MAX_TRACKS} tracks per release.`;
  if (!f.title.trim()) return 'Add a title.';
  if (!f.artist.trim()) return 'Add the artist.';
  if (f.title.trim().length > 100 || f.artist.trim().length > 100) return 'Keep names under 100 characters.';
  if (f.description.length > 1000) return 'Keep the description under 1000 characters.';
  return null;
}

/** GorillaPool inscription search by MAP fields (q = base64 JSON), newest first. */
export function feedUrl(offset = 0, limit = PAGE_SIZE, api = GP_API): string {
  const q = btoa(JSON.stringify({ map: { app: MEDIA_APP, type: RELEASE_TYPE } }));
  return `${api}/inscriptions/search?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}&dir=desc`;
}

export type ReleaseTrack = { origin: string; title: string; contentType: string; kind: 'music' | 'video'; url: string };
export type Release = {
  origin: string;
  owner: string;
  title: string;
  artist: string;
  genre: string;
  description: string;
  ai: boolean;
  coverUrl: string;
  tracks: ReleaseTrack[];
  height: number;
  idx: number;
};

type RawData = { map?: Record<string, unknown>; insc?: { file?: { type?: unknown } } };
type Raw = {
  outpoint?: unknown;
  owner?: unknown;
  height?: unknown;
  idx?: unknown;
  origin?: { outpoint?: unknown; data?: RawData };
  data?: RawData;
};
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** The `tracks` MAP field → safe tracks only (well-formed origins, audio/video types). */
export function parseTracks(json: string): ReleaseTrack[] {
  let list: unknown;
  try {
    list = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: ReleaseTrack[] = [];
  for (const t of list.slice(0, MAX_TRACKS) as { o?: unknown; t?: unknown; k?: unknown }[]) {
    const origin = str(t?.o);
    const contentType = str(t?.k);
    if (!OUTPOINT.test(origin) || !isSafeTrackType(contentType)) continue;
    const url = contentUrls(origin)[0];
    if (!url) continue;
    out.push({ origin, title: str(t?.t).slice(0, 100) || 'Untitled', contentType, kind: trackKind(contentType), url });
  }
  return out;
}

/** Indexer rows → releases: tagged, a raster cover, a well-formed origin and at least one safe track. */
export function parseFeed(json: unknown): Release[] {
  if (!Array.isArray(json)) return [];
  const out: Release[] = [];
  for (const r of json as Raw[]) {
    const data = r?.origin?.data ?? r?.data;
    const map = data?.map ?? {};
    if (str(map.app) !== MEDIA_APP || str(map.type) !== RELEASE_TYPE) continue;
    if (!isSafeCoverType(str(data?.insc?.file?.type))) continue;
    const origin = str(r?.origin?.outpoint) || str(r?.outpoint);
    if (!OUTPOINT.test(origin)) continue;
    const tracks = parseTracks(str(map.tracks));
    if (!tracks.length) continue;
    out.push({
      origin,
      owner: str(r.owner),
      title: str(map.name).slice(0, 100) || 'Untitled',
      artist: str(map.artist).slice(0, 100) || 'Unknown artist',
      genre: str(map.genre).slice(0, 40),
      description: str(map.description).slice(0, 1000),
      ai: str(map.ai) === 'true',
      coverUrl: contentUrls(origin)[0],
      tracks,
      height: num(r.height),
      idx: num(r.idx),
    });
  }
  return out;
}

/** Newest first (unmined on top), no duplicates. */
export function visibleReleases(list: Release[]): Release[] {
  const seen = new Set<string>();
  return list
    .filter((r) => {
      const id = r.origin.toLowerCase();
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => (b.height || Infinity) - (a.height || Infinity) || b.idx - a.idx);
}

/** Move one track up/down in the list (reorder in the form). */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) return list;
  const next = [...list];
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x);
  return next;
}
