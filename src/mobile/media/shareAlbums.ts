/**
 * Albums with a pretty, shareable address on desktop.bwalletx.com (owner, 12 Oct 2026):
 *   /media/artist/<artist>/album/<slug> ↔ /m/media/album/<id>
 *   /media/artist/<artist>              ↔ /m/media/browse?artist=<name>
 * vite.config.web.ts also writes a static page per album and artist with its own share card, so X, Twetch and
 * bChatX (which do not run JavaScript) see the album, not the generic wallet card. Add an entry to share another.
 */
export type ShareAlbum = {
  /** The album id in the store (the manifest's albumId). */
  id: string;
  slug: string;
  title: string;
  artist: string;
  artistSlug: string;
  description: string;
  /** Share card, 1200x630, emitted from src/web/. */
  og: string;
  ogAlt: string;
  /** Square cover, emitted next to the static page. */
  cover: string;
  sponsoredBy?: string;
  /** One line on the share page and card: what is free and what is paid. */
  pricing: string;
  /** sponsored: the sponsor's pot pays (free to the listener); otherwise 1 sat/sec. */
  tracks: { title: string; seconds: number; sponsored?: boolean }[];
};

export const SHARE_ALBUMS: ShareAlbum[] = [
  {
    id: 'first-12',
    slug: 'echoes-in-the-abyss',
    title: 'Echoes in the Abyss',
    artist: 'VexVoid',
    artistSlug: 'vexvoid',
    description: 'VexVoid’s album on bWalletX. First 6 tracks free (sponsored by VexVoid) · tracks 7–12 at 1 sat/sec.',
    og: 'og-album-echoes-in-the-abyss.jpg',
    ogAlt:
      'Echoes in the Abyss by VexVoid on bWalletX: first 6 tracks free (sponsored by VexVoid), tracks 7–12 at 1 sat/sec',
    cover: 'src/mobile/media/featured/vexvoid-cover.jpg',
    sponsoredBy: 'VexVoid',
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
];

export const albumPublicPath = (a: ShareAlbum) => `/media/artist/${a.artistSlug}/album/${a.slug}`;
export const artistPublicPath = (artistSlug: string) => `/media/artist/${artistSlug}`;
