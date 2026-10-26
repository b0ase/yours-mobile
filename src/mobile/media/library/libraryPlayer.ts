import { playQueue, stop, type Track } from '../player';
import { libTrackId } from './albumTheme';
import type { LibraryAlbum } from './library';

/**
 * Plays library albums through the app's one player (player.ts). Playback never touches the wallet's theme: the
 * album's colours live only on the player's own container (albumTheme.ts albumStyle).
 */
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

export function playAlbum(album: LibraryAlbum, start = 0, onExpand?: () => void): void {
  if (!album.tracks.length) return;
  playQueue(libraryQueue(album, onExpand), Math.max(0, Math.min(start, album.tracks.length - 1)));
}

/** Closing the player: playback stops. Nothing global was changed, so nothing needs putting back. */
export function closeLibrary(): void {
  stop();
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
