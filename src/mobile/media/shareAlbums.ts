/**
 * Albums with a pretty, shareable address on desktop.bwalletx.com (owner, 12 Oct 2026):
 *   /media/artist/<artist>/album/<slug> ↔ /m/media/album/<id>
 *   /media/artist/<artist>              ↔ /m/media/browse?artist=<name>
 * vite.config.web.ts also writes a static page per album and artist with its own share card, so X, Twetch and
 * bChatX (which do not run JavaScript) see the album, not the generic wallet card. Add an entry here and its page
 * text in src/web/shareAlbums.ts. Only the address parts live here: this file is in the app bundle, and the page text
 * (prices) must stay out of store builds.
 */
/** The address parts of a shareable album. */
export type ShareAlbumRoute = { id: string; slug: string; title: string; artist: string; artistSlug: string };

export const SHARE_ALBUMS: ShareAlbumRoute[] = [
  {
    id: 'first-12',
    slug: 'echoes-in-the-abyss',
    title: 'Echoes in the Abyss',
    artist: 'VexVoid',
    artistSlug: 'vexvoid',
  },
];

export const albumPublicPath = (a: ShareAlbumRoute) => `/media/artist/${a.artistSlug}/album/${a.slug}`;
export const artistPublicPath = (artistSlug: string) => `/media/artist/${artistSlug}`;
