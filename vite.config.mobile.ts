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
const FRAME_SHIM = `<script>(function(){var m=window.parent!==window&&window.parent.__yoursMobile;if(m){Object.defineProperty(window,'chrome',{value:m.attachFrame(window),writable:true,configurable:true});window.__yoursPlatform=window.parent.__yoursPlatform;}})();</script>`;

// Brand: MOBILE_BRAND=bcorp (default) is "bCorp Wallet", the store brand;
// MOBILE_BRAND=bwallet swaps in bWallet's; MOBILE_BRAND=yours keeps upstream's
// name and logos (internal testing only). All get the mobile theme settings
// (Browser tab, fork repo link) via src/mobile/brand/theme.ts.
const MOBILE_BRAND = (['yours', 'bwallet'] as const).find((b) => b === process.env.MOBILE_BRAND) ?? 'bcorp';
const LOGO_DIR = MOBILE_BRAND === 'bcorp' ? 'src/mobile/brand/bcorp' : 'src/mobile/brand';
const BRAND: Record<string, string> = {
  [resolve(__dirname, 'src/theme.ts')]: resolve(__dirname, 'src/mobile/brand/theme.ts'),
};
const BWALLET_ASSETS: Record<string, string> = {
  [resolve(__dirname, 'src/utils/constants.ts')]: resolve(__dirname, 'src/mobile/brand/constants.ts'),
  [resolve(__dirname, 'src/assets/logos/icon.png')]: resolve(__dirname, LOGO_DIR, 'icon.png'),
  [resolve(__dirname, 'src/assets/logos/horizontal-logo.png')]: resolve(__dirname, LOGO_DIR, 'horizontal-logo.png'),
  [resolve(__dirname, 'src/assets/logos/white-logo.png')]: resolve(__dirname, LOGO_DIR, 'white-logo.png'),
};
if (MOBILE_BRAND !== 'yours') Object.assign(BRAND, BWALLET_ASSETS);

const brand = (): Plugin => ({
  name: 'bwallet-brand',
  enforce: 'pre',
  // Default account avatar at a stable path (it is stored in account records).
  generateBundle() {
    if (MOBILE_BRAND === 'yours') return;
    this.emitFile({
      type: 'asset',
      fileName: 'bwallet-avatar.png',
      source: readFileSync(resolve(__dirname, LOGO_DIR, 'icon.png')),
    });
  },
  async resolveId(source, importer, options) {
    if (!importer || Object.values(BRAND).includes(importer)) return null;
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
    const swap = resolved && BRAND[resolved.id.split('?')[0]];
    return swap ? swap + (resolved!.id.includes('?') ? resolved!.id.slice(resolved!.id.indexOf('?')) : '') : null;
  },
});

// bcorp builds: reword upstream UI strings that name "Yours" as the product, at build
// time, so upstream's files stay unchanged (and mergeable). Each entry must still match:
// the build fails if upstream rewords one, so the list can't silently go stale.
const BCORP_TEXT: Record<string, [string, string][]> = {
  'src/components/SyncingBlocks.tsx': [['Yours SPV Wallet will be ready', 'bCorp Wallet will be ready']],
  'src/components/UpgradeNotification.tsx': [['Welcome to Yours Wallet 5.0', 'Welcome to bCorp Wallet']],
  'src/components/BackupPromo.tsx': [['Yours Wallet now uses', 'bCorp Wallet uses']],
  'src/components/ProviderPicker.tsx': [['Official storage partner of Yours Wallet.', 'Default wallet storage provider.']],
  'src/components/TopNav.tsx': [['alt="Yours Wallet"', 'alt="bCorp Wallet"']],
  'src/components/YoursIcon.tsx': [['alt="Yours Head"', 'alt="bCorp Wallet"']],
  'src/pages/requests/UsbCheckRequest.tsx': [['is asking Yours to', 'is asking bCorp Wallet to']],
  'src/pages/onboarding/RestoreAccount.tsx': [
    ['alt="Yours"', 'alt="bCorp Wallet"'],
    ['Upload Yours JSON', 'Upload wallet backup JSON'],
  ],
};
const bcorpText = (): Plugin => ({
  name: 'bcorp-text',
  enforce: 'pre',
  transform(code, id) {
    if (MOBILE_BRAND !== 'bcorp') return null;
    const file = id.split('?')[0].slice(__dirname.length + 1);
    const swaps = BCORP_TEXT[file];
    if (!swaps) return null;
    for (const [from, to] of swaps) {
      if (!code.includes(from)) this.error(`bcorp-text: "${from}" not found in ${file}`);
      code = code.split(from).join(to);
    }
    return { code, map: null };
  },
  transformIndexHtml: (html) =>
    MOBILE_BRAND === 'bcorp' ? html.replace('<title>Yours Wallet</title>', '<title>bCorp Wallet</title>') : html,
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
    plugins: [brand(), bcorpText(), mobilePages()],
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
      plugins: () => [brand(), bcorpText(), polyfills()],
    },
    define: {
      __MOBILE_VERSION__: JSON.stringify(version),
      __MOBILE_BRAND__: JSON.stringify(MOBILE_BRAND),
    },
  }),
);
