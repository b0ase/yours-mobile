/**
 * Page text for the shareable albums (src/mobile/media/shareAlbums.ts holds their addresses). Build time only
 * (albumPages.ts), never in the app bundle, so store builds carry no prices.
 */
import { SHARE_ALBUMS as ROUTES, type ShareAlbumRoute } from '../mobile/media/shareAlbums';

export type ShareAlbum = ShareAlbumRoute & {
  description: string;
  /** Share card, 1200x630, emitted from src/web/. */
  og: string;
  ogAlt: string;
  /** Square cover, emitted next to the static page. */
  cover: string;
  sponsoredBy?: string;
  /** Artist page extras (one per artist; read from the artist's first album). */
  artistBio?: string;
  artistCover?: string;
  artistSite?: string;
  /** bMusic video stream (manifest path on BMUSIC_HOST) and its release id, shown on the artist page. */
  video?: { title: string; manifest: string; releaseId: string };
  /** One line on the share page and card: what is free and what is paid. */
  pricing: string;
  /** sponsored: the sponsor's pot pays (free to the listener); otherwise 1 sat/sec. */
  tracks: { title: string; seconds: number; sponsored?: boolean }[];
};

const COPY: Record<string, Omit<ShareAlbum, keyof ShareAlbumRoute>> = {
  'first-12': {
    description: 'VexVoid’s album on bWalletX. First 6 tracks free (sponsored by VexVoid) · tracks 7–12 at 1 sat/sec.',
    og: 'og-album-echoes-in-the-abyss.jpg',
    ogAlt:
      'Echoes in the Abyss by VexVoid on bWalletX: first 6 tracks free (sponsored by VexVoid), tracks 7–12 at 1 sat/sec',
    cover: 'src/mobile/media/featured/vexvoid-cover.jpg',
    sponsoredBy: 'VexVoid',
    artistBio: 'V3XV0ID: trainyards, rooftops, the void',
    artistCover: 'https://bitcoin-music.vercel.app/bmusic/streams/first-12/cover.jpg',
    artistSite: 'https://www.vexvoid.com/album',
    video: {
      title: 'Four Ton Shadow',
      manifest: '/bmusic/streams/four-ton-shadow-video/manifest.json',
      releaseId: 'four-ton-shadow-video-01',
    },
    pricing: 'First 6 tracks free (sponsored by VexVoid) · tracks 7–12 at 1 sat/sec',
    tracks: [
      { title: 'Echoes in the Abyss', seconds: 116, sponsored: true },
      { title: 'Shadowed Depths', seconds: 180, sponsored: true },
      { title: 'Shadows of the Mind', seconds: 209, sponsored: true },
      { title: 'Echoes in the Fog', seconds: 135, sponsored: true },
      { title: 'Echoes in the Mist', seconds: 200, sponsored: true },
      { title: 'Echoes in the Dust', seconds: 192, sponsored: true },
      { title: 'Shadows in the Smoke', seconds: 179 },
      { title: 'Whispers in the Smoke', seconds: 258 },
      { title: 'Midnight Reverie', seconds: 235 },
      { title: 'Shadows and Silhouettes', seconds: 241 },
      { title: 'Shadowed Whispers', seconds: 195 },
      { title: 'Shadows of the Streets', seconds: 135 },
    ],
  },
};

/** bMusic server the artist page reads live prices, listeners and the sponsor pot from (CORS *). */
export const BMUSIC_HOST = 'https://bitcoin-music.vercel.app';

export const SHARE_ALBUMS: ShareAlbum[] = ROUTES.map((r) => {
  const c = COPY[r.id];
  if (!c) throw new Error(`No page text for shared album ${r.id} (src/web/shareAlbums.ts)`);
  return { ...r, ...c };
});
