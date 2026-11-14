import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { resolve } from 'path';
import { brandDefines, extensionBrandPlugins } from './vite.brand';
import { MOBILE_DEFINES } from './vite.config.mobile';

// Background service worker config - ES module format
export default defineConfig({
  base: './',
  plugins: [
    ...extensionBrandPlugins(),
    nodePolyfills({
      include: ['buffer', 'process', 'util', 'stream', 'crypto', 'assert', 'url', 'path'],
      globals: {
        Buffer: true,
        process: true,
      },
    }),
  ],
  resolve: {
    alias: {
      path: 'path-browserify',
      'xdelta3-wasm': resolve(__dirname, 'src/stubs/empty.ts'),
    },
    preserveSymlinks: true,
  },
  logLevel: 'error',
  build: {
    outDir: 'build',
    emptyOutDir: false,
    lib: {
      // Upstream background + Web Push handlers (src/mobile/push/extBackground.ts).
      entry: resolve(__dirname, 'src/mobile/push/extBackground.ts'),
      name: 'background',
      formats: ['es'],
      fileName: () => 'background.js',
    },
    rollupOptions: {
      external: ['chrome'],
      onwarn(warning, warn) {
        if (warning.message?.includes('externalized for browser')) return;
        if (warning.code === 'CIRCULAR_DEPENDENCY') return;
        warn(warning);
      },
    },
    sourcemap: true,
  },
  define: {
    'process.env': {},
    ...brandDefines(),
    // The Store's address for the wallet's own unsent-payment pass (src/mobile/themeOrder/storeHeard.ts): this worker
    // is built without the pages' paymail defines, and only that module reads this one. Same env and default as
    // __PAYMAIL_API__ in vite.config.mobile.ts.
    __STORE_API__: JSON.stringify(process.env.BWALLET_PAYMAIL_API ?? 'https://pay.bwallet.space'),
    // The Store/paymail API base (pay.bwallet.space): utils/exchangeRate.ts is in the background's import graph (its
    // fetch is tree-shaken out today), so if the background ever asks for the price it asks the shared per-minute one
    // (GET /api/price) first, like the pages. Only the API base: __PAYMAIL_DOMAIN__ stays undefined here,
    // so paymailEnabled() is still false in the background and no paymail flow changes.
    __PAYMAIL_API__: MOBILE_DEFINES.__PAYMAIL_API__,
  },
});
