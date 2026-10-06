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
const ICONS = resolve(__dirname, 'assets/bwalletx-ext');

const webShell = (): Plugin => ({
  name: 'bwallet-web-shell',
  transformIndexHtml: {
    order: 'post',
    handler(html, ctx) {
      // Overlay pages (prompt, sweep, USB) load inside the wallet; only the shell is the site.
      if (!ctx.filename.endsWith('mobile.html')) return html;
      return html
        .replace(
          '</head>',
          [
            '    <meta name="description" content="bWalletX: the BSV wallet for tokens, media and apps." />',
            '    <link rel="manifest" href="./manifest.webmanifest" />',
            '    <link rel="icon" href="./favicon.ico" sizes="any" />',
            '    <link rel="apple-touch-icon" href="./icons/icon192.png" />',
            '    <meta name="apple-mobile-web-app-capable" content="yes" />',
            '    <meta name="apple-mobile-web-app-title" content="bWalletX" />',
            '  </head>',
          ].join('\n'),
        )
        .replace('<body>', `<body>\n    <div class="bwallet-web-banner" role="status">${BANNER}</div>`);
    },
  },
  generateBundle() {
    for (const f of readdirSync(ICONS).filter((n) => n.endsWith('.png'))) {
      this.emitFile({ type: 'asset', fileName: `icons/${f}`, source: readFileSync(resolve(ICONS, f)) });
    }
    this.emitFile({ type: 'asset', fileName: 'favicon.ico', source: readFileSync(resolve(ICONS, 'favicon.ico')) });
    // web.bwalletx.com/agents: a static page about agent accounts, the CLI and MCP, and its share image.
    this.emitFile({ type: 'asset', fileName: 'agents.html', source: readFileSync(resolve(__dirname, 'src/web/agents.html')) });
    this.emitFile({ type: 'asset', fileName: 'og-agents.png', source: readFileSync(resolve(__dirname, 'src/web/og-agents.png')) });
    // Hosting headers (no framing, no referrer) for Vercel: web.bwalletx.com.
    this.emitFile({
      type: 'asset',
      fileName: 'vercel.json',
      source: readFileSync(resolve(__dirname, 'src/web/vercel.json')),
    });
    this.emitFile({
      type: 'asset',
      fileName: 'manifest.webmanifest',
      source: JSON.stringify(
        {
          name: 'bWalletX',
          short_name: 'bWalletX',
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
