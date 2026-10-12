import type { Manifest, StreamTrack } from './api';

/** The manifest's placeholder title; a real one (or a cover) added to the manifest later wins. */
const PLACEHOLDER_TITLES = new Set(['first 12']);

const norm = (s: string) => s.trim().toLowerCase();

export type AlbumView = {
  title: string;
  artist: string;
  cover: string;
  /** Paid tracks, each with its index in manifest.tracks (the engine plays by that index). */
  paid: { index: number; track: StreamTrack }[];
};

/** One album: the free headline track first, then the streamed tracks, without listing the headline twice. */
export const albumView = (
  m: Pick<Manifest, 'title' | 'artist' | 'tracks' | 'cover' | 'headline'>,
  fallback: { title: string; artist: string; cover: string; headlineTitle: string },
  /** URL the manifest was fetched from: a relative cover resolves against it. */
  base?: string,
): AlbumView => {
  let cover = fallback.cover;
  if (m.cover) {
    try {
      cover = new URL(m.cover, base).href;
    } catch {
      /* keep the local cover */
    }
  }
  return {
    title: m.title && !PLACEHOLDER_TITLES.has(norm(m.title)) ? m.title : fallback.title,
    artist: m.artist?.trim() || fallback.artist,
    cover,
    // The headline (by trackId, else by title) plays from the free local copy, so it is listed once, first.
    paid: m.tracks
      .map((track, index) => ({ index, track }))
      .filter(({ track }) => track.trackId !== m.headline && norm(track.title) !== norm(fallback.headlineTitle)),
  };
};
