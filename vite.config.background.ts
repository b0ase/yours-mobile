import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { resolve } from 'path';
import { brandDefines, extensionBrandPlugins } from './vite.brand';

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
  },
});
