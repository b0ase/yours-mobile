import type { Track } from '../player';
import echoesUrl from './vexvoid-echoes-in-the-abyss.mp3';
import vexvoidCover from './vexvoid-cover.jpg';

/**
 * Free tracks on the Media page (owner, 11 Oct 2026: "users can play one track in the media player we give them for
 * free, for now"). Shown as a featured card, never added to the user's own library (the U2-album lesson). The mp3 is
 * an asset URL, fetched only when played.
 */
export type FeaturedTrack = Track & { artist: string; label: string };

export const FEATURED_TRACKS: readonly FeaturedTrack[] = [
  {
    id: 'free:vexvoid-echoes-in-the-abyss',
    title: 'Echoes in the Abyss',
    artist: 'V3XV0ID',
    label: 'From VexVoid',
    url: echoesUrl,
    artwork: vexvoidCover,
  },
];

/** The player's queue for a featured track: just that track. */
export const featuredQueue = (t: FeaturedTrack): Track[] => [
  { id: t.id, title: `${t.title} · ${t.artist}`, url: t.url, artwork: t.artwork },
];

/**
 * Media's one music product (owner, 12 Oct 2026): the VexVoid album "Echoes in the Abyss", led by its free headline
 * track, followed by the pay-per-second tracks from the bMusic stream (stream/album.ts). Shown as one album, never as
 * a separate single plus a separate stream.
 */
export const HEADLINE_ALBUM = {
  id: 'album:vexvoid-echoes-in-the-abyss',
  title: 'Echoes in the Abyss',
  artist: 'VexVoid',
  cover: vexvoidCover,
  headline: FEATURED_TRACKS[0],
} as const;
