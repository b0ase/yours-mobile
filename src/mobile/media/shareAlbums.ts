/**
 * Albums with a pretty, shareable address on desktop.bwalletx.com (owner, 12 Oct 2026). The music store lives at
 * /bmusic (owner, 12 Oct 2026: /media is for the user's own media); old /media/... links 308 there (src/web/vercel.json):
 *   /bmusic/artist/<artist>/album/<slug> ↔ /m/media/album/<id>
 *   /bmusic/artists/<artist>             ↔ /m/media/browse?artist=<name>
 * vite.config.web.ts also writes a static page per album and artist with its own share card, so X, Twetch and
 * bChatX (which do not run JavaScript) see the album, not the generic wallet card. Add an entry here and its page
 * text in src/web/shareAlbums.ts. Only the address parts live here: this file is in the app bundle, and the page text
 * (prices) must stay out of store builds.
 */
/** The address parts of a shareable album. */
export type ShareAlbumRoute = {
  id: string;
  slug: string;
  title: string;
  artist: string;
  artistSlug: string;
  /** Where the artist's tips go: $handle or paymail (tip/TipButton.tsx). */
  tipTo?: string;
};

export const SHARE_ALBUMS: ShareAlbumRoute[] = [
  {
    id: 'first-12',
    slug: 'echoes-in-the-abyss',
    title: 'Echoes in the Abyss',
    artist: 'VexVoid',
    artistSlug: 'vexvoid',
    tipTo: '$vexvoid',
  },
];

export const albumPublicPath = (a: ShareAlbumRoute) => `/bmusic/artist/${a.artistSlug}/album/${a.slug}`;
export const artistPublicPath = (artistSlug: string) => `/bmusic/artists/${artistSlug}`;
/** Every artist with a shareable page. */
export const ARTISTS_PATH = '/bmusic/artists';
