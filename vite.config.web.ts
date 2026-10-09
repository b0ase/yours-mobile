import { defineConfig, mergeConfig, type Plugin } from 'vite';
import { resolve } from 'path';
import { readFileSync, readdirSync } from 'fs';
import mobileConfig from './vite.config.mobile';

/**
 * bWalletX web wallet (web.bwalletx.com): the mobile UI as a static site (build-web/), for any
 * browser. Same code and storage as `pnpm preview:mobile`: Capacitor's web
 * fallbacks run (src/mobile/native.ts), so the wallet's storage.local, which
 * holds the password-encrypted keys, lives in this browser's localStorage and
 * nothing leaves it. Connecting other websites is not built yet: see
 * docs/WEB-WALLET.md.
 */

const BANNER = 'Web wallet beta — your keys stay in this browser. Connecting other websites is coming soon.';
/**
 * A tab keeps the build it first loaded (an SPA never refetches index.html), so tabs opened before a deploy showed an
 * older layout next to newer ones (owner, 9 Oct 2026: "sometimes full width, sometimes half"). When the tab comes
 * back into view, compare this page's main-*.js with the live index.html and reload if a newer build is out. The
 * wallet's keys stay encrypted in localStorage and the unlock session in sessionStorage, both survive a reload.
 */
const STALE_BUILD = `(function(){var m=document.querySelector('script[type=module][src*="main-"]');if(!m)return;var mine=m.getAttribute('src').split('/').pop(),busy=0;function check(){if(busy||document.visibilityState!=='visible')return;busy=1;fetch('./',{cache:'no-store'}).then(function(r){return r.ok?r.text():''}).then(function(h){var x=/assets\\/(main-[^"']+\\.js)/.exec(h);if(x&&x[1]!==mine)location.reload()}).catch(function(){}).then(function(){busy=0})}document.addEventListener('visibilitychange',check);addEventListener('focus',check)})();`;

const ICONS = resolve(__dirname, 'assets/bwalletx-ext');
/** The wide build is bWalletX Desktop (owner, 9 Oct 2026: "web" is the classic wallet, the beta becomes "desktop"). */
const DESKTOP = process.env.VITE_WIDE_WEB === '1';
const APP_TITLE = DESKTOP ? 'bWalletX Desktop' : 'bWalletX';

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
            '    <link rel="manifest" href="./manifest.webmanifest" />',
            '    <link rel="icon" href="./favicon.ico" sizes="any" />',
            '    <link rel="apple-touch-icon" href="./icons/icon192.png" />',
            '    <meta name="apple-mobile-web-app-capable" content="yes" />',
            `    <meta name="apple-mobile-web-app-title" content="${APP_TITLE}" />`,
            '  </head>',
          ].join('\n'),
        )
        .replace('<body>', `<body>\n    <div class="bwallet-web-banner" role="status">${BANNER}</div>`)
        .replace('</body>', `    <script>${STALE_BUILD}</script>\n  </body>`);
    },
  },
  generateBundle() {
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
    plugins: [webShell(), webCss()],
    // public/ is the extension's (Yours manifest and sprout icons); the web wallet emits its own.
    publicDir: false,
    build: { outDir: 'build-web', sourcemap: false },
    define: { __BWALLET_WEB__: 'true' },
  }),
);
