import { defineConfig, mergeConfig, type Plugin } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { resolve } from 'path';
import { readFileSync, renameSync } from 'fs';
import baseConfig from './vite.config';

/**
 * Mobile (Capacitor) build. One WebView hosts the popup UI (mobile.html →
 * index.html), the background as a Web Worker, and the extension's other
 * pages as overlay iframes. Output: build-mobile/ (Capacitor webDir).
 */

const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'));

const polyfills = () =>
  nodePolyfills({
    include: ['buffer', 'process', 'util', 'stream', 'crypto', 'assert', 'url', 'path'],
    globals: { Buffer: true, process: true },
  });

// Overlay pages get their chrome shim from the top window before any module runs.
const FRAME_SHIM = `<script>(function(){var m=window.parent!==window&&window.parent.__yoursMobile;if(m){Object.defineProperty(window,'chrome',{value:m.attachFrame(window),writable:true,configurable:true});}})();</script>`;

// Brand: MOBILE_BRAND=yours (default) keeps upstream's name and logos;
// MOBILE_BRAND=bwallet swaps in bWallet's. Both get the mobile theme settings
// (Browser tab, fork repo link) via src/mobile/brand/theme.ts.
const MOBILE_BRAND = process.env.MOBILE_BRAND === 'bwallet' ? 'bwallet' : 'yours';
const BRAND: Record<string, string> = {
  [resolve(__dirname, 'src/theme.ts')]: resolve(__dirname, 'src/mobile/brand/theme.ts'),
};
const BWALLET_ASSETS: Record<string, string> = {
  [resolve(__dirname, 'src/utils/constants.ts')]: resolve(__dirname, 'src/mobile/brand/constants.ts'),
  [resolve(__dirname, 'src/assets/logos/icon.png')]: resolve(__dirname, 'src/mobile/brand/icon.png'),
  [resolve(__dirname, 'src/assets/logos/horizontal-logo.png')]: resolve(
    __dirname,
    'src/mobile/brand/horizontal-logo.png',
  ),
  [resolve(__dirname, 'src/assets/logos/white-logo.png')]: resolve(__dirname, 'src/mobile/brand/white-logo.png'),
};
if (MOBILE_BRAND === 'bwallet') Object.assign(BRAND, BWALLET_ASSETS);

const brand = (): Plugin => ({
  name: 'bwallet-brand',
  enforce: 'pre',
  // Default account avatar at a stable path (it is stored in account records).
  generateBundle() {
    if (MOBILE_BRAND !== 'bwallet') return;
    this.emitFile({
      type: 'asset',
      fileName: 'bwallet-avatar.png',
      source: readFileSync(resolve(__dirname, 'src/mobile/brand/icon.png')),
    });
  },
  async resolveId(source, importer, options) {
    if (!importer || Object.values(BRAND).includes(importer)) return null;
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
    const swap = resolved && BRAND[resolved.id.split('?')[0]];
    return swap ? swap + (resolved!.id.includes('?') ? resolved!.id.slice(resolved!.id.indexOf('?')) : '') : null;
  },
});

const mobilePages = (): Plugin => ({
  name: 'yours-mobile-pages',
  transformIndexHtml: {
    order: 'pre',
    handler(html, ctx) {
      const isShell = ctx.filename.endsWith('mobile.html');
      let out = html.replace(
        /<meta name="viewport"[^>]*>/,
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no" />',
      );
      // Upstream's PWA manifest link points at extension icons; not used in-app.
      out = out.replace(/\s*<link rel="manifest"[^>]*>/, '');
      if (!isShell) {
        out = out.replace('<head>', `<head>\n    ${FRAME_SHIM}`);
        out = out.replace('</head>', '    <link rel="stylesheet" href="./src/mobile/mobile.css" />\n  </head>');
      }
      return out;
    },
  },
  // Capacitor loads index.html from webDir.
  writeBundle(options) {
    const dir = options.dir ?? resolve(__dirname, 'build-mobile');
    renameSync(resolve(dir, 'mobile.html'), resolve(dir, 'index.html'));
  },
});

export default mergeConfig(
  baseConfig,
  defineConfig({
    plugins: [brand(), mobilePages()],
    build: {
      outDir: 'build-mobile',
      target: 'es2022',
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'mobile.html'),
          'sweep-tab': resolve(__dirname, 'sweep-tab.html'),
          'prompt-tab': resolve(__dirname, 'prompt.html'),
          'usb-tab': resolve(__dirname, 'usb.html'),
        },
      },
    },
    worker: {
      format: 'es',
      plugins: () => [brand(), polyfills()],
    },
    define: {
      __MOBILE_VERSION__: JSON.stringify(version),
      __MOBILE_BRAND__: JSON.stringify(MOBILE_BRAND),
    },
  }),
);
