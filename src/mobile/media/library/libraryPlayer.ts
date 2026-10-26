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
    // The small cover: the mini player and lock screen show it at once (Now Playing cross-fades the full one in).
    artwork: album.thumb ?? album.cover,
    subtitle: album.artist ?? album.title,
    album: album.title,
    ...(onExpand ? { onExpand } : {}),
  }));

/** The album now in the player: its colours and full cover for Now Playing (memory only, this session). */
let playingAlbum: Pick<LibraryAlbum, 'id' | 'theme' | 'cover'> | null = null;
export const libraryNowPlaying = () => playingAlbum;

/**
 * Starts an album in the app's one player. The <audio> element lives in player.ts (module level, outside every
 * page), so changing tab or page never re-mounts or stops it. The mini player's tap opens Now Playing where you are.
 */
export function playAlbum(album: LibraryAlbum, start = 0, onExpand: () => void = () => setNowPlayingOpen(true)): void {
  if (!album.tracks.length) return;
  playingAlbum = { id: album.id, theme: album.theme, cover: album.cover };
  playQueue(libraryQueue(album, onExpand), Math.max(0, Math.min(start, album.tracks.length - 1)));
}

/** Closing the player: playback stops. Nothing global was changed, so nothing needs putting back. */
export function closeLibrary(): void {
  stop();
  playingAlbum = null;
  setNowPlayingOpen(false);
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
