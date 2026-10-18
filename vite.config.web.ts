import { defineConfig, mergeConfig, type Plugin } from 'vite';
import { resolve } from 'path';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import mobileConfig from './vite.config.mobile';
import { writeAlbumPages } from './src/web/albumPages';
import { installStaleBuildCheck } from './src/web/staleBuild';
import { BANNER_VIDEO, bannerHtml, installWebBanner } from './src/web/betaBanner';

/**
 * bWalletX web wallet (web.bwalletx.com): the mobile UI as a static site (build-web/), for any
 * browser. Same code and storage as `pnpm preview:mobile`: Capacitor's web
 * fallbacks run (src/mobile/native.ts), so the wallet's storage.local, which
 * holds the password-encrypted keys, lives in this browser's localStorage and
 * nothing leaves it. Connecting other websites is not built yet: see
 * docs/WEB-WALLET.md.
 */

/** Optional hazard-tape video for the beta banner (src/web/betaBanner.ts): copied when the file exists. */
const BANNER_VIDEO_SRC = resolve(__dirname, 'public', BANNER_VIDEO);
const HAS_BANNER_VIDEO = existsSync(BANNER_VIDEO_SRC);
const BANNER_SCRIPT = `(${installWebBanner.toString()})();`;
/** Newer build pick-up without reloading under the user: src/web/staleBuild.ts (inlined, self-contained). */
const STALE_BUILD = `(${installStaleBuildCheck.toString()})();`;

const ICONS = resolve(__dirname, 'assets/bwalletx-ext');
/** The wide build is bWalletX Desktop (owner, 9 Oct 2026: "web" is the classic wallet, the beta becomes "desktop"). */
const DESKTOP = process.env.VITE_WIDE_WEB === '1';
/** Root for links in the shell: absolute on Desktop (deep paths serve index.html), relative on the classic web. */
const ROOT = '/';
const APP_TITLE = DESKTOP ? 'bWalletX Desktop' : 'bWalletX';

// desktop.bwalletx.com share card (owner, 9 Oct 2026). Source: bwalletx-site media-src/og/og-desktop-v1.html.
const DESKTOP_OG = 'https://desktop.bwalletx.com/og-desktop-v1.png';
const DESKTOP_SHARE = [
  '    <meta property="og:type" content="website" />',
  '    <meta property="og:url" content="https://desktop.bwalletx.com/" />',
  '    <meta property="og:title" content="bWalletX Desktop" />',
  '    <meta property="og:description" content="Your whole wallet on one big screen: money, bMail, chat and apps side by side." />',
  `    <meta property="og:image" content="${DESKTOP_OG}" />`,
  '    <meta property="og:image:width" content="1200" />',
  '    <meta property="og:image:height" content="630" />',
  '    <meta property="og:image:alt" content="bWalletX Desktop: your whole wallet on one big screen" />',
  '    <meta name="twitter:card" content="summary_large_image" />',
  `    <meta name="twitter:image" content="${DESKTOP_OG}" />`,
];

/** Edition installs served under /themes/<id>/, each with a web.bwalletx.com/<id> entry page (accent.ts LINKED_INSTALLS). */
export const THEME_INSTALLS: Record<string, string> = {
  white: '#f7f6f2',
  pink: '#F4A7C0',
  blue: '#8EC5F0',
  yellow: '#F7DA4A',
  vexvoid: '#000000',
  npg: '#000000',
  npgx: '#000000',
};
const INSTALL_NAMES: Record<string, string> = { npg: 'NPG', npgx: 'NPGX', vexvoid: 'VexVoid' };

const webShell = (): Plugin => ({
  name: 'bwallet-web-shell',
  transformIndexHtml: {
    order: 'post',
    handler(html, ctx) {
      // Overlay pages (prompt, sweep, USB) load inside the wallet; only the shell is the site.
      if (!ctx.filename.endsWith('mobile.html')) return html;
      return html
        .replace(/<title>[^<]*<\/title>/, `<title>${APP_TITLE}</title>`)
        .replace(
          '</head>',
          [
            '    <meta name="description" content="bWalletX: the BSV wallet for tokens, media and apps." />',
            ...(DESKTOP ? DESKTOP_SHARE : []),
            `    <link rel="manifest" href="${ROOT}manifest.webmanifest" />`,
            `    <link rel="icon" href="${ROOT}favicon.ico" sizes="any" />`,
            `    <link rel="apple-touch-icon" href="${ROOT}icons/icon192.png" />`,
            '    <meta name="apple-mobile-web-app-capable" content="yes" />',
            `    <meta name="apple-mobile-web-app-title" content="${APP_TITLE}" />`,
            '  </head>',
          ].join('\n'),
        )
        .replace('<body>', `<body>\n    ${bannerHtml(HAS_BANNER_VIDEO)}\n    <script>${BANNER_SCRIPT}</script>`)
        .replace('</body>', `    <script>${STALE_BUILD}</script>\n  </body>`);
    },
  },
  generateBundle() {
    if (HAS_BANNER_VIDEO)
      this.emitFile({ type: 'asset', fileName: BANNER_VIDEO, source: readFileSync(BANNER_VIDEO_SRC) });
    for (const f of readdirSync(ICONS).filter((n) => n.endsWith('.png'))) {
      this.emitFile({ type: 'asset', fileName: `icons/${f}`, source: readFileSync(resolve(ICONS, f)) });
    }
    this.emitFile({ type: 'asset', fileName: 'favicon.ico', source: readFileSync(resolve(ICONS, 'favicon.ico')) });
    // web.bwalletx.com/agents: a static page about agent accounts, the CLI and MCP, and its share image.
    this.emitFile({
      type: 'asset',
      fileName: 'agents.html',
      source: readFileSync(resolve(__dirname, 'src/web/agents.html')),
    });
    // desktop.bwalletx.com/desktop: what Desktop is and how to install it, and its share image.
    if (DESKTOP) {
      this.emitFile({
        type: 'asset',
        fileName: 'desktop.html',
        source: readFileSync(resolve(__dirname, 'src/web/desktop.html')),
      });
      this.emitFile({
        type: 'asset',
        fileName: 'og-desktop-page-v1.png',
        source: readFileSync(resolve(__dirname, 'src/web/og-desktop-page-v1.png')),
      });
    }
    if (DESKTOP)
      this.emitFile({
        type: 'asset',
        fileName: 'og-desktop-v1.png',
        source: readFileSync(resolve(__dirname, 'src/web/og-desktop-v1.png')),
      });
    this.emitFile({
      type: 'asset',
      fileName: 'og-agents.png',
      source: readFileSync(resolve(__dirname, 'src/web/og-agents.png')),
    });
    // Web Push service worker (src/mobile/push/register.ts registers it from Settings › Notifications).
    this.emitFile({
      type: 'asset',
      fileName: 'push-sw.js',
      source: readFileSync(resolve(__dirname, 'src/web/push-sw.js')),
    });
    // Hosting headers (no framing, no referrer) for Vercel: web.bwalletx.com.
    this.emitFile({
      type: 'asset',
      fileName: 'vercel.json',
      source: readFileSync(resolve(__dirname, 'src/web/vercel.json')),
    });
    // Install UI (Chrome's richer install sheet on desktop): one wide screenshot of the welcome screen.
    this.emitFile({
      type: 'asset',
      fileName: 'install-wide.png',
      source: readFileSync(resolve(__dirname, 'src/web/install-wide.png')),
    });
    // Per-colour installs (bwalletx.com theme-apps): /themes/<colour>/manifest.json starts at /?theme=<colour>;
    // src/mobile/theme/accent.ts swaps the manifest link to it so Add to Home Screen gets the coloured icon.
    for (const [colour, bg] of Object.entries(THEME_INSTALLS)) {
      for (const size of [180, 192, 512])
        this.emitFile({
          type: 'asset',
          fileName: `themes/${colour}/icon-${size}.png`,
          source: readFileSync(resolve(__dirname, `src/web/themes/icon-${colour}-${size}.png`)),
        });
      const name = `bWallet ${INSTALL_NAMES[colour] ?? colour[0].toUpperCase() + colour.slice(1)}`;
      this.emitFile({
        type: 'asset',
        fileName: `themes/${colour}/manifest.json`,
        source: JSON.stringify(
          {
            id: `/bwallet-${colour}`,
            name,
            short_name: 'bWallet',
            start_url: `/${colour}`,
            scope: '/',
            display: 'standalone',
            background_color: bg,
            theme_color: bg,
            icons: [
              { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
              { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
            ],
          },
          null,
          2,
        ),
      });
    }
    this.emitFile({
      type: 'asset',
      fileName: 'manifest.webmanifest',
      source: JSON.stringify(
        {
          id: '/',
          name: APP_TITLE,
          short_name: APP_TITLE,
          description: 'The BSV wallet for tokens, media and apps.',
          start_url: './',
          scope: './',
          display: 'standalone',
          background_color: '#000000',
          theme_color: '#010101',
          icons: [
            { src: 'icons/icon192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icons/icon512.png', sizes: '512x512', type: 'image/png' },
            { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
          screenshots: [
            {
              src: 'install-wide.png',
              sizes: '1440x900',
              type: 'image/png',
              form_factor: 'wide',
              label: 'bWalletX on the desktop',
            },
          ],
        },
        null,
        2,
      ),
    });
  },
});

/**
 * web.bwalletx.com/<edition> (/white, /pink, /vexvoid, /npg …): the same wallet (same origin, same data) with that
 * edition's head, so Add to Home Screen installs its icon (iOS reads apple-touch-icon from the page at that moment)
 * and manifest. vercel.json rewrites /<id> to <id>.html; accent.ts treats /<id> like ?theme=<id> on first open.
 */
export const editionEntryHtml = (html: string, id: string): string =>
  html
    .replace(/<link rel="manifest" href="[^"]*" \/>/, `<link rel="manifest" href="/themes/${id}/manifest.json" />`)
    .replace(
      /<link rel="apple-touch-icon" href="[^"]*" \/>/,
      `<link rel="apple-touch-icon" href="/themes/${id}/icon-180.png" />`,
    )
    .replace(
      /<meta name="theme-color" content="[^"]*" \/>/,
      `<meta name="theme-color" content="${THEME_INSTALLS[id]}" />`,
    )
    .replace(
      /<meta name="apple-mobile-web-app-title" content="[^"]*" \/>/,
      '<meta name="apple-mobile-web-app-title" content="bWallet" />',
    )
    .replace(
      /<meta name="color-scheme" content="[^"]*" \/>/,
      `<meta name="color-scheme" content="${editionScheme(id)}" />`,
    )
    // Status bar, safe-area strip and page follow the edition from the first paint (owner, 16 Oct 2026: a black bar
    // across the top of White). Paper editions: the default (light) iOS bar on the paper; dark editions: black.
    .replace(
      '</head>',
      [
        `    <meta name="apple-mobile-web-app-status-bar-style" content="${editionScheme(id) === 'light' ? 'default' : 'black'}" />`,
        `    <style>html,body{background:${THEME_INSTALLS[id]}}</style>`,
        '  </head>',
      ].join('\n'),
    );
const editionScheme = (id: string): 'light' | 'dark' => (THEME_INSTALLS[id] === '#000000' ? 'dark' : 'light');
export const whiteEntryHtml = (html: string): string => editionEntryHtml(html, 'white');

const editionEntries = (): Plugin => ({
  name: 'bwallet-edition-entries',
  closeBundle() {
    if (DESKTOP) return;
    const index = resolve(__dirname, 'build-web/index.html');
    if (!existsSync(index)) return;
    const html = readFileSync(index, 'utf8');
    for (const id of Object.keys(THEME_INSTALLS))
      writeFileSync(resolve(__dirname, `build-web/${id}.html`), editionEntryHtml(html, id));
  },
});

/** Desktop: a static page with its own share card per shareable album and artist (src/web/albumPages.ts). */
const albumPages = (): Plugin => ({
  name: 'bwallet-album-pages',
  closeBundle() {
    if (DESKTOP) writeAlbumPages(resolve(__dirname, 'build-web'), 'https://desktop.bwalletx.com', __dirname);
  },
});

// Loaded after mobile.css so its rules win (see src/web/web.css).
const webCss = (): Plugin => ({
  name: 'bwallet-web-css',
  enforce: 'pre',
  transform(code, id) {
    if (!id.split('?')[0].endsWith('/src/mobile/main.ts')) return null;
    return {
      code: code.replace("import './mobile.css';", "import './mobile.css';\nimport '../web/web.css';"),
      map: null,
    };
  },
});

export default mergeConfig(
  mobileConfig,
  defineConfig({
    plugins: [webShell(), webCss(), albumPages(), editionEntries()],
    // public/ is the extension's (Yours manifest and sprout icons); the web wallet emits its own.
    publicDir: false,
    // Both web hosts serve index.html for deep paths (/lock/subscriptions, /m/market, /bapp/bchatx): relative ./assets/
    // would resolve to /bapp/assets/… and 404, leaving only the static beta strip on black. Absolute paths everywhere.
    base: '/',
    build: { outDir: 'build-web', sourcemap: false },
    define: { __BWALLET_WEB__: 'true' },
  }),
);
