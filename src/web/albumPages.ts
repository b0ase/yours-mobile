import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { ARTISTS_PATH, albumPublicPath, artistPublicPath } from '../mobile/media/shareAlbums';
import { SHARE_ALBUMS, type ShareAlbum } from './shareAlbums';

/**
 * Static pages for shareable album and artist links (owner, 12 Oct 2026). Crawlers (X, Twetch, bChatX's OG fetcher)
 * do not run JavaScript and the SPA fallback serves one generic card, so each album gets its own index.html at its
 * public path: a copy of the built wallet page with the album's title, description and share card. The page boots the
 * app, which opens the album or artist screen inside the shell after create or unlock if needed
 * (src/mobile/url/UrlSync.tsx, media/artists/ArtistsPage.tsx; owner 12 Oct 2026: "in app, not loose pages"). Vercel serves real files before the SPA rewrite.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

type Meta = { title: string; description: string; url: string; image: string; imageAlt: string };

const head = (html: string, m: Meta) => {
  const tags = [
    `    <meta name="description" content="${esc(m.description)}" />`,
    `    <link rel="canonical" href="${m.url}" />`,
    '    <meta property="og:type" content="music.album" />',
    `    <meta property="og:url" content="${m.url}" />`,
    `    <meta property="og:title" content="${esc(m.title)}" />`,
    `    <meta property="og:description" content="${esc(m.description)}" />`,
    `    <meta property="og:image" content="${m.image}" />`,
    '    <meta property="og:image:width" content="1200" />',
    '    <meta property="og:image:height" content="630" />',
    `    <meta property="og:image:alt" content="${esc(m.imageAlt)}" />`,
    '    <meta name="twitter:card" content="summary_large_image" />',
    `    <meta name="twitter:title" content="${esc(m.title)}" />`,
    `    <meta name="twitter:description" content="${esc(m.description)}" />`,
    `    <meta name="twitter:image" content="${m.image}" />`,
  ];
  return (
    html
      // Drop the wallet's generic share tags; the album's replace them.
      .replace(/\s*<meta (?:name|property)="(?:description|og:[^"]*|twitter:[^"]*)"[^>]*>/g, '')
      .replace(/\s*<link rel="canonical"[^>]*>/g, '')
      .replace(/<title>[^<]*<\/title>/, `<title>${esc(m.title)}</title>`)
      .replace('</head>', `${tags.join('\n')}\n  </head>`)
      // The page sits in a sub-folder: the build's ./assets, ./icons… must resolve from the site root.
      .replace(/(src|href)="\.\//g, '$1="/')
  );
};

const write = (dir: string, path: string, html: string) => {
  const d = join(dir, path);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'index.html'), html);
};

/** Writes the album and artist pages into the built site `dir` (needs dir/index.html). */
export const writeAlbumPages = (dir: string, origin: string, root: string) => {
  const shell = readFileSync(join(dir, 'index.html'), 'utf8');
  const coverPath = (a: ShareAlbum) => `/bmusic/covers/${a.artistSlug}-${a.slug}.jpg`;
  mkdirSync(join(dir, 'bmusic/covers'), { recursive: true });
  for (const a of SHARE_ALBUMS) {
    copyFileSync(resolve(root, a.cover), join(dir, coverPath(a)));
    copyFileSync(resolve(root, 'src/web', a.og), join(dir, a.og));
    const page = head(shell, {
      title: `${a.title} · ${a.artist} · bWalletX`,
      description: a.description,
      url: `${origin}${albumPublicPath(a)}`,
      image: `${origin}/${a.og}`,
      imageAlt: a.ogAlt,
    });
    write(dir, albumPublicPath(a), page);
  }
  const artists = [...new Set(SHARE_ALBUMS.map((a) => a.artistSlug))].map((slug) =>
    SHARE_ALBUMS.filter((a) => a.artistSlug === slug),
  );
  const index = head(shell, {
    title: 'Artists · bMusic · bWalletX',
    description: `Artists on bMusic: ${artists.map((x) => x[0].artist).join(', ')}.`,
    url: `${origin}${ARTISTS_PATH}`,
    image: `${origin}/${artists[0][0].og}`,
    imageAlt: artists[0][0].ogAlt,
  }).replace('content="music.album"', 'content="website"');
  write(dir, ARTISTS_PATH, index);
  for (const slug of new Set(SHARE_ALBUMS.map((a) => a.artistSlug))) {
    const albums = SHARE_ALBUMS.filter((a) => a.artistSlug === slug);
    const name = albums[0].artist;
    const page = head(shell, {
      title: `${name} · bWalletX`,
      description: `${name} on bWalletX: ${albums.map((a) => a.title).join(', ')}.`,
      url: `${origin}${artistPublicPath(slug)}`,
      image: `${origin}/${albums[0].og}`,
      imageAlt: albums[0].ogAlt,
    }).replace('content="music.album"', 'content="profile"');
    write(dir, artistPublicPath(slug), page);
  }
};
