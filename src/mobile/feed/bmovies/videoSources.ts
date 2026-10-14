/**
 * Feed › bMusic and bNews video sources: a typed registry of public clip feeds, merged into one reel
 * (bWalletX only, behind BMOVIES_FEED_ENABLED like the rest of feed/bmovies/*).
 *
 * Every live source today is a bmovies.app skin feed: GET https://www.bmovies.app/api/feed?skin=<skin>
 * returns `{ items, nextCursor }` in the same shape as plain bMovies (bmovies.ts parses it). The
 * bMusic skin (bmovies.app/bmusic) has no feed branch of its own yet, so it serves the bMovies
 * catalogue (owner 14 Oct: same content for now). New sources are added here; a disabled entry
 * records what it needs before it can be switched on.
 */
import { BMOVIES_ORIGIN, fetchClips, type Clip, type ClipPage, type FetchJson, defaultJson } from './bmovies';

export type VideoSource = {
  id: string;
  /** Shown as "via <label>". */
  label: string;
  /** The feed URL (a bmovies.app skin feed); pages add cursor and limit. */
  url: string;
  /** The bmovies.app skin its clips open in. */
  skin?: string;
  enabled: boolean;
  /** Why it is off and what it needs (disabled entries only). */
  todo?: string;
};

const skinFeed = (skin: string) => `${BMOVIES_ORIGIN}/api/feed?skin=${skin}`;

/** bMusic: the bMusic skin of bmovies.app, then future music-video sources (off until they qualify). */
export const BMUSIC_SOURCES: readonly VideoSource[] = [
  { id: 'bmusic', label: 'bMusic', url: skinFeed('bmusic'), skin: 'bmusic', enabled: true },
  {
    id: 'vexvoid',
    label: 'VexVoid',
    url: skinFeed('vexvoid'),
    skin: 'vexvoid',
    enabled: false,
    // TODO(vexvoid): items are an .mp3 trailerUrl plus silent visualiser clips[] and no createdAt.
    todo: 'Needs a rendered music video (one mp4 with audio) per track and a createdAt, or a reel slide that plays the mp3 over its clips.',
  },
  {
    id: 'npgx',
    label: 'NPGX',
    url: skinFeed('npgx'),
    skin: 'npgx',
    enabled: false,
    // TODO(npgx): the skin feed is a create card plus .mp3 album tracks; the npgx repo's
    // /api/music-video-clips?track=<slug> lists per-track mp4 fragments but npgx.website now serves the bMovies skin.
    todo: 'Needs a public list of finished NPGX music videos (mp4 with audio, title, cover, date).',
  },
  {
    id: 'gzone',
    label: 'GZONE',
    url: skinFeed('gzone'),
    skin: 'gzone',
    enabled: false,
    // TODO(gzone): items are YouTube embeds (embedUrl, no trailerUrl), mostly battles/promos.
    todo: 'Needs YouTube-embed slides in the reel (iframe, one at a time) and a music-video filter or mp4 mirrors.',
  },
];

/** bNews: news video channels. */
export const BNEWS_SOURCES: readonly VideoSource[] = [
  // GMEHL (gmehl.rocks, a bmovies.app skin): Gavin Mehl's syndicated X video posts.
  { id: 'gmehl', label: 'GMEHL', url: skinFeed('gmehl'), skin: 'gmehl', enabled: true },
];

/** Per-source cursors: undefined = not started, null = finished. */
export type Cursors = Record<string, string | null | undefined>;

export type MergedPage = { clips: Clip[]; cursors: Cursors; more: boolean };

/** Merge pages: dedupe by id (the first source listed wins), newest first. */
export const mergeClips = (pages: readonly Clip[][]): Clip[] => {
  const seen = new Set<string>();
  const out: Clip[] = [];
  for (const page of pages)
    for (const c of page)
      if (!seen.has(c.id)) {
        seen.add(c.id);
        out.push(c);
      }
  return out.sort((a, b) => b.at - a.at);
};

/**
 * The next page from every enabled source still going, merged. A source that fails is skipped for
 * this page; it throws only when every source failed on the first page.
 */
export async function fetchMerged(
  sources: readonly VideoSource[],
  cursors: Cursors = {},
  json: FetchJson = defaultJson,
): Promise<MergedPage> {
  const live = sources.filter((s) => s.enabled && cursors[s.id] !== null);
  const results = await Promise.all(
    live.map((s) =>
      fetchClips(cursors[s.id] ?? null, json, s.url).then(
        (p: ClipPage) => ({ s, p }),
        () => ({ s, p: null }),
      ),
    ),
  );
  const first = live.every((s) => cursors[s.id] === undefined);
  if (first && live.length && results.every((r) => !r.p)) throw new Error('No source is answering');
  const next: Cursors = { ...cursors };
  const pages: Clip[][] = [];
  for (const { s, p } of results) {
    if (!p) continue;
    next[s.id] = p.next;
    pages.push(p.clips.map((c) => ({ ...c, via: s.label, skin: s.skin })));
  }
  return { clips: mergeClips(pages), cursors: next, more: live.some((s) => next[s.id] !== null) };
}
