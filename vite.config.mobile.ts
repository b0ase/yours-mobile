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

// Brand: MOBILE_BRAND=bcorp (default) is "bWallet", the store brand;
// MOBILE_BRAND=bwallet swaps in bWallet's; MOBILE_BRAND=yours keeps upstream's
// name and logos (internal testing only). All get the mobile theme settings
// (Browser tab, fork repo link) via src/mobile/brand/theme.ts.
const MOBILE_BRAND = (['yours', 'bwallet'] as const).find((b) => b === process.env.MOBILE_BRAND) ?? 'bcorp';
const LOGO_DIR = MOBILE_BRAND === 'bcorp' ? 'src/mobile/brand/bcorp' : 'src/mobile/brand';
const BRAND: Record<string, string> = {
  [resolve(__dirname, 'src/theme.ts')]: resolve(__dirname, 'src/mobile/brand/theme.ts'),
  // Mobile tab bar: Wallet · Market · Apps · Media · Chat (src/mobile/tabs).
  [resolve(__dirname, 'src/components/BottomMenu.tsx')]: resolve(__dirname, 'src/mobile/tabs/BottomMenu.tsx'),
  [resolve(__dirname, 'src/hooks/useBottomMenu.tsx')]: resolve(__dirname, 'src/mobile/tabs/useBottomMenu.tsx'),
  // Account drawer (Phantom-style) in place of the dropdown + GitHub button.
  [resolve(__dirname, 'src/components/TopNav.tsx')]: resolve(__dirname, 'src/mobile/tabs/TopNav.tsx'),
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
    if (!importer) return null;
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
    const swap = resolved && BRAND[resolved.id.split('?')[0]];
    // A replacement may import the file it replaces (brand/constants re-exports upstream);
    // every other import from a replacement is still swapped (mobile TopNav's logo).
    if (swap && swap === importer.split('?')[0]) return null;
    return swap ? swap + (resolved!.id.includes('?') ? resolved!.id.slice(resolved!.id.indexOf('?')) : '') : null;
  },
});

// bcorp builds: reword upstream UI strings that name "Yours" as the product, at build
// time, so upstream's files stay unchanged (and mergeable). Each entry must still match:
// the build fails if upstream rewords one, so the list can't silently go stale.
const BCORP_TEXT: Record<string, [string, string][]> = {
  // Accounts created before the rebrand stored upstream's hosted avatar; show ours instead.
  'src/hooks/useIdentity.ts': [
    ["if (!uri) return '';", "if (!uri) return '';\n  if (uri.includes('i.ibb.co/zGcthBv/yours-org-light.png')) return 'bwallet-avatar.png';"],
  ],
  'src/components/SyncingBlocks.tsx': [['Yours SPV Wallet will be ready', 'bWallet will be ready']],
  'src/components/UpgradeNotification.tsx': [['Welcome to Yours Wallet 5.0', 'Welcome to bWallet']],
  'src/components/BackupPromo.tsx': [['Yours Wallet now uses', 'bWallet uses']],
  'src/components/ProviderPicker.tsx': [['Official storage partner of Yours Wallet.', 'Default wallet storage provider.']],
  'src/components/TopNav.tsx': [['alt="Yours Wallet"', 'alt="bWallet"']],
  'src/components/YoursIcon.tsx': [['alt="Yours Head"', 'alt="bWallet"']],
  'src/pages/requests/UsbCheckRequest.tsx': [['is asking Yours to', 'is asking bWallet to']],
  'src/pages/onboarding/RestoreAccount.tsx': [
    ['alt="Yours"', 'alt="bWallet"'],
    ['Upload Yours JSON', 'Upload wallet backup JSON'],
    // Yours users don't know a Yours seed restores as bWallet: list Yours by name too (same import path).
    [
      "import masterWallet from '../../assets/master-wallet.svg';",
      "import masterWallet from '../../assets/master-wallet.svg';\nimport yoursOriginalLogo from '../../mobile/brand/yours-white-logo.png';",
    ],
    [
      "    {\n      id: 'relayx',",
      "    {\n      id: 'yours',\n      label: 'Yours Wallet',\n      logo: (\n        <div className=\"flex items-center justify-center rounded-lg\" style={{ backgroundColor: '#000', width: '2.25rem', height: '2.25rem', padding: '0.35rem' }}>\n          <img src={yoursOriginalLogo} alt=\"Yours Wallet\" style={{ width: '1rem', height: 'auto' }} />\n        </div>\n      ),\n    },\n    {\n      id: 'relayx',",
    ],
    ['key={opt.id}', 'key={opt.label}'],
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
    MOBILE_BRAND === 'bcorp' ? html.replace('<title>Yours Wallet</title>', '<title>bWallet</title>') : html,
});

// All mobile builds: mount the mobile-only tab routes (/m/settings, /m/media,
// /m/market) in upstream's router without editing App.tsx. Same must-match rule.
const MOBILE_TEXT: Record<string, [string, string][]> = {
  // "Forgot password? Restore with recovery phrase" under Unlock (src/mobile/forgot).
  'src/components/UnlockWallet.tsx': [
    [
      "import { QuickUnlock } from './QuickUnlock';",
      "import { QuickUnlock } from './QuickUnlock';\nimport { ForgotPassword } from '../mobile/forgot/ForgotPassword';",
    ],
    [
      '{!usbEnabled && <QuickUnlock theme={theme} onUnlock={onUnlock} />}',
      '{!usbEnabled && <QuickUnlock theme={theme} onUnlock={onUnlock} />}\n<ForgotPassword theme={theme} />',
    ],
  ],
  'src/App.tsx': [
    // After a forgot-password wipe, open straight on the restore-from-phrase screen.
    [
      "import { MemoryRouter as Router, Route, Routes } from 'react-router-dom';",
      "import { MemoryRouter as Router, Route, Routes } from 'react-router-dom';\nimport { initialRoute } from './mobile/forgot/wipe';",
    ],
    ['<Router>', '<Router initialEntries={[initialRoute()]}>'],
    [
      "const BrowserPage = lazy(() => import('./mobile/BrowserPage'));",
      "const BrowserPage = lazy(() => import('./mobile/BrowserPage'));\nconst MobileRoutes = lazy(() => import('./mobile/tabs/MobileRoutes'));\nconst MiniPlayer = lazy(() => import('./mobile/media/MiniPlayer'));",
    ],
    [
      '<Route path="/settings" element={<Settings />} />',
      '<Route path="/settings" element={<Settings />} />\n<Route path="/m/*" element={<Suspense fallback={null}><MobileRoutes /></Suspense>} />',
    ],
    // Media tab's now-playing bar, app-wide so audio controls follow every tab.
    ['<UsbBackupPill />', '<UsbBackupPill />\n<Suspense fallback={null}><MiniPlayer /></Suspense>'],
  ],
};
const mobileText = (): Plugin => ({
  name: 'mobile-text',
  enforce: 'pre',
  transform(code, id) {
    const file = id.split('?')[0].slice(__dirname.length + 1);
    const swaps = MOBILE_TEXT[file];
    if (!swaps) return null;
    for (const [from, to] of swaps) {
      if (!code.includes(from)) this.error(`mobile-text: "${from}" not found in ${file}`);
      code = code.split(from).join(to);
    }
    return { code, map: null };
  },
});

/**
 * bCorp palette: upstream's greens become BSV gold in the bcorp build only, so
 * upstream files stay untouched and mergeable.
 */
const BCORP_COLOURS: [RegExp, string][] = [
  [/#A1FF8B/gi, '#FFD24D'],
  [/#9EFF8A/gi, '#FFD24D'],
  [/#34D399/gi, '#EAB300'],
  [/rgba\(52,\s*211,\s*153/g, 'rgba(234, 179, 0'],
  [/\btext-green-400\b/g, 'text-yellow-400'],
];
const bcorpColours = (): Plugin => ({
  name: 'bcorp-colours',
  enforce: 'pre',
  transform(code, id) {
    if (MOBILE_BRAND !== 'bcorp' || !/\/src\/.*\.(tsx?|css)$/.test(id.split('?')[0])) return null;
    let out = code;
    for (const [re, to] of BCORP_COLOURS) out = out.replace(re, to);
    return out === code ? null : { code: out, map: null };
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
    plugins: [brand(), mobileText(), bcorpText(), bcorpColours(), mobilePages()],
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
      plugins: () => [brand(), bcorpText(), bcorpColours(), polyfills()],
    },
    define: {
      __MOBILE_VERSION__: JSON.stringify(version),
      __MOBILE_BRAND__: JSON.stringify(MOBILE_BRAND),
      // Market tab fee address (src/mobile/market/fee.ts). Empty = no fee.
      __MARKET_FEE_ADDRESS__: JSON.stringify(process.env.BWALLET_MARKET_FEE_ADDRESS ?? ''),
    },
  }),
);
