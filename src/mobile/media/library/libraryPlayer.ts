import { playQueue, stop, subscribe, type Track } from '../player';
import { albumForPlayer, libTrackId, wearAlbum } from './albumTheme';
import type { LibraryAlbum } from './library';

/**
 * Plays library albums through the app's one player (player.ts) and keeps the theme in step with it: the playing
 * track's album is worn, anything else (stop, the mini player's X, another queue) puts the user's theme back.
 * The albums live in memory only, for this session.
 */
let known: LibraryAlbum[] = [];
let following = false;

const follow = () => {
  if (following) return;
  following = true;
  subscribe((s) => wearAlbum(albumForPlayer(s, known)));
};

export const libraryQueue = (album: LibraryAlbum, onExpand?: () => void): Track[] =>
  album.tracks.map((t) => ({
    id: libTrackId(album.id, t.id),
    title: t.title,
    url: t.url,
    artwork: album.cover,
    subtitle: album.artist ?? album.title,
    album: album.title,
    ...(onExpand ? { onExpand } : {}),
  }));

export function playAlbum(albums: LibraryAlbum[], album: LibraryAlbum, start = 0, onExpand?: () => void): void {
  known = albums;
  follow();
  if (!album.tracks.length) return;
  playQueue(libraryQueue(album, onExpand), Math.max(0, Math.min(start, album.tracks.length - 1)));
}

/** Closing Now Playing: playback stops and the user's own theme comes back. */
export function closeLibrary(): void {
  stop();
  wearAlbum(null);
}

// Now Playing open / closed, shared with the mini player's expand.
let open = false;
const openers = new Set<(v: boolean) => void>();
export const nowPlayingOpen = () => open;
export const setNowPlayingOpen = (v: boolean) => {
  open = v;
  openers.forEach((l) => l(v));
};
export const onNowPlayingOpen = (fn: (v: boolean) => void) => {
  openers.add(fn);
  return () => void openers.delete(fn);
};
