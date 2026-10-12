import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { ARTISTS_PATH, albumPublicPath, artistPublicPath } from '../mobile/media/shareAlbums';
import { BMUSIC_HOST, SHARE_ALBUMS, type ShareAlbum } from './shareAlbums';

/**
 * Static pages for shareable album and artist links (owner, 12 Oct 2026). Crawlers (X, Twetch, bChatX's OG fetcher)
 * do not run JavaScript and the SPA fallback serves one generic card, so each album gets its own index.html at its
 * public path: a copy of the built wallet page with the album's title, description and share card, plus a light
 * album view (cover, tracks, sponsor) shown over the app. "Listen" removes it and the wallet opens the album, after
 * create or unlock if needed (src/mobile/url/UrlSync.tsx). Vercel serves real files before the SPA rewrite.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

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

const STYLE = `<style>
#bwx-share{position:fixed;inset:0;z-index:2147483000;overflow-y:auto;background:#000;color:#fff;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}
#bwx-share .w{max-width:980px;margin:0 auto;padding:48px 16px 64px;display:flex;gap:40px;flex-wrap:wrap}
#bwx-share img.c{width:min(360px,100%);height:auto;aspect-ratio:1;align-self:flex-start;object-fit:cover;border-radius:12px;box-shadow:0 0 0 1px rgba(245,184,0,.5),0 0 60px rgba(245,184,0,.15)}
#bwx-share .i{flex:1;min-width:260px}
#bwx-share .k{color:#f5b800;font-size:13px;font-weight:700;letter-spacing:.18em;text-transform:uppercase}
#bwx-share h1{margin:10px 0 4px;font-size:40px;line-height:1.05;letter-spacing:-.02em}
#bwx-share .a{color:#ddd;font-size:20px}
#bwx-share .s{margin:18px 0 6px;color:#f5b800;font-weight:600}
#bwx-share .n{color:#999;font-size:13px;margin-bottom:18px}
#bwx-share button{background:#f5b800;color:#000;border:0;border-radius:999px;padding:12px 28px;font-size:16px;font-weight:700;cursor:pointer}
#bwx-share ol{margin:24px 0 0;padding:0;list-style:none;border-top:1px solid #222}
#bwx-share li{display:flex;gap:12px;padding:9px 2px;border-bottom:1px solid #222;font-size:14px}
#bwx-share li span:first-child{width:22px;color:#777;text-align:right}
#bwx-share li span:nth-child(2){flex:1}
#bwx-share li span:nth-child(3){color:#777}
#bwx-share li .t{width:96px;text-align:right;font-size:11px;font-weight:700;text-transform:uppercase;color:#777}
#bwx-share li .t.g{color:#f5b800}
#bwx-share a{color:#f5b800}
</style>`;

const LISTEN = `<script>document.getElementById('bwx-listen').onclick=function(){var e=document.getElementById('bwx-share');e&&e.remove()};</script>`;

const sponsorLine = (a: ShareAlbum) => `<div class="s">${esc(a.pricing)}</div>`;

const albumView = (a: ShareAlbum, coverUrl: string) =>
  `${STYLE}<div id="bwx-share"><div class="w"><img class="c" src="${coverUrl}" alt="${esc(a.title)} cover" />` +
  `<div class="i"><div class="k">Album</div><h1>${esc(a.title)}</h1>` +
  `<div class="a"><a href="${artistPublicPath(a.artistSlug)}">${esc(a.artist)}</a></div>${sponsorLine(a)}` +
  `<div class="n">Listen in bWalletX: create a wallet or unlock yours.</div>` +
  `<button id="bwx-listen" type="button">Listen</button><ol>` +
  a.tracks
    .map(
      (t, i) =>
        `<li><span>${i + 1}</span><span>${esc(t.title)}</span><span>${mmss(t.seconds)}</span><span class="t${t.sponsored ? ' g' : ''}">${t.sponsored ? `On ${esc(a.sponsoredBy ?? a.artist)}` : '1 sat/sec'}</span></li>`,
    )
    .join('') +
  `</ol></div></div></div>${LISTEN}`;

/** Live parts of the artist page, filled in the browser from the bMusic server (prices, listeners, sponsor pot). */
const artistLive = (a: ShareAlbum) => {
  const ids = a.tracks.map((_, i) => `${a.id}-${String(i + 1).padStart(2, '0')}`);
  if (a.video) ids.push(a.video.releaseId);
  return `<script>(function(){var H=${JSON.stringify(BMUSIC_HOST)},A=${JSON.stringify(a.id)},S=${JSON.stringify(a.artistSite ?? '')};
function j(p){return fetch(H+p).then(function(r){return r.ok?r.json():null}).catch(function(){return null})}
function bsv(s){return (s/1e8).toLocaleString(undefined,{maximumFractionDigits:8})+' BSV'}
${JSON.stringify(ids)}.forEach(function(id){j('/api/bmusic/release/'+id).then(function(r){var e=document.getElementById('buy-'+id);if(!e||!r)return;
e.innerHTML=r.minted?'Original owned':(r.forSale&&r.mintPriceSats?'<a href="'+S+'" target="_blank" rel="noopener">Buy the original · '+bsv(r.mintPriceSats)+'</a>':'')})});
j('/api/bmusic/leaderboard?albumId='+encodeURIComponent(A)).then(function(r){var e=document.getElementById('bwx-top');if(!e||!r)return;var l=r.listeners||[];
e.innerHTML=l.length?l.slice(0,10).map(function(x,i){var n=String(x.handle||x.name||x.paymail||x.identityKey||'listener').slice(0,32).replace(/[<>&"]/g,'');return '<li><span>'+(i+1)+'</span><span>'+n+'</span><span>'+(x.secondsTotal?Math.round(x.secondsTotal/60)+' min':'')+'</span></li>'}).join(''):'<li><span></span><span>Be the first listener'+(r.anonCount?' ('+r.anonCount+' anonymous so far)':'')+'</span></li>'});
j('/api/bmusic/stream/sponsored?albumId='+encodeURIComponent(A)).then(function(r){var e=document.getElementById('bwx-pot');if(!e||!r||!r.capSats)return;var p=Math.max(0,Math.min(100,100*(r.potSats||0)/r.capSats));
e.innerHTML='<div class="n" style="margin:0 0 6px">Sponsor pot: '+bsv(r.potSats||0)+(r.sponsored?' · paying for tracks 1–6':' · empty')+'</div><div style="height:8px;background:#222;border-radius:4px"><div style="height:8px;width:'+p+'%;background:#f5b800;border-radius:4px"></div></div>'});
})();</script>`;
};

const artistView = (name: string, albums: ShareAlbum[], coverOf: (a: ShareAlbum) => string) => {
  const a = albums[0];
  const tracks = albums
    .map(
      (al) =>
        `<h2 style="margin:28px 0 0;font-size:20px"><a href="${albumPublicPath(al)}" style="color:#fff">${esc(al.title)}</a></h2><ol>` +
        al.tracks
          .map((t, i) => {
            const id = `${al.id}-${String(i + 1).padStart(2, '0')}`;
            return `<li><span>${i + 1}</span><span>${esc(t.title)}<br /><small id="buy-${id}" style="font-size:12px"></small></span><span>${mmss(t.seconds)}</span><span class="t${t.sponsored ? ' g' : ''}">${t.sponsored ? `On ${esc(al.sponsoredBy ?? al.artist)}` : '1 sat/sec'}</span></li>`;
          })
          .join('') +
        '</ol>',
    )
    .join('');
  const video = a.video
    ? `<h2 style="margin:28px 0 6px;font-size:20px">Video: ${esc(a.video.title)}</h2><div class="n">Streams in bWalletX at 1 sat/sec. <span id="buy-${a.video.releaseId}"></span></div>`
    : '';
  return (
    `${STYLE}<div id="bwx-share"><div class="w"><img class="c" src="${a.artistCover ?? coverOf(a)}" alt="${esc(name)}" />` +
    `<div class="i"><div class="k"><a href="${ARTISTS_PATH}">Artists</a></div><h1>${esc(name)}</h1>` +
    (a.artistBio ? `<div class="a">${esc(a.artistBio)}</div>` : '') +
    `<div class="s">${esc(a.pricing)}</div><div id="bwx-pot" style="margin:10px 0 16px"></div>` +
    `<button id="bwx-listen" type="button">Listen</button>` +
    (a.artistSite
      ? ` <a href="${a.artistSite}" target="_blank" rel="noopener" style="margin-left:14px">${esc(a.artistSite.replace(/^https:\/\//, ''))}</a>`
      : '') +
    tracks +
    video +
    `<h2 style="margin:28px 0 0;font-size:20px">Top listeners</h2><ol id="bwx-top"></ol>` +
    `</div></div></div>${LISTEN}${artistLive(a)}`
  );
};

const artistsView = (artists: ShareAlbum[][], coverOf: (a: ShareAlbum) => string) =>
  `${STYLE}<div id="bwx-share"><div class="w" style="display:block"><div class="k">bMusic</div><h1>Artists</h1>` +
  `<div style="display:flex;gap:24px;flex-wrap:wrap;margin:24px 0 28px">` +
  artists
    .map((albums) => {
      const a = albums[0];
      return (
        `<a href="${artistPublicPath(a.artistSlug)}" style="text-decoration:none;color:#fff;width:220px"><img class="c" style="width:220px" src="${a.artistCover ?? coverOf(a)}" alt="" />` +
        `<div style="margin-top:8px;font-weight:700">${esc(a.artist)}</div><div class="n" style="margin:2px 0 8px">${albums.length} release${albums.length === 1 ? '' : 's'}${a.video ? ' · 1 video' : ''}</div>` +
        `<span style="color:#f5b800;font-weight:700">Listen</span></a>`
      );
    })
    .join('') +
  `</div><button id="bwx-listen" type="button">Open in bWalletX</button></div></div>${LISTEN}`;

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
    write(dir, albumPublicPath(a), page.replace(/<body([^>]*)>/, `<body$1>\n${albumView(a, coverPath(a))}`));
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
  write(dir, ARTISTS_PATH, index.replace(/<body([^>]*)>/, `<body$1>\n${artistsView(artists, coverPath)}`));
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
    write(
      dir,
      artistPublicPath(slug),
      page.replace(/<body([^>]*)>/, `<body$1>\n${artistView(name, albums, coverPath)}`),
    );
  }
};
