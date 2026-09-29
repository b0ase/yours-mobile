import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { resolve } from 'path';

// Provider script for the in-app dApp browser → build-mobile/dapp-provider.js.
// Run after vite.config.mobile.ts (it empties build-mobile).
export default defineConfig({
  plugins: [
    nodePolyfills({
      include: ['buffer', 'process', 'util', 'stream', 'crypto', 'assert', 'url', 'path'],
      globals: { Buffer: true, process: true },
    }),
  ],
  resolve: { alias: { path: 'path-browserify' }, preserveSymlinks: true },
  logLevel: 'warn',
  build: {
    outDir: 'build-mobile',
    emptyOutDir: false,
    target: 'es2020',
    sourcemap: false,
    lib: {
      entry: resolve(__dirname, 'src/mobile/dapp/provider.ts'),
      name: 'yoursProvider',
      formats: ['iife'],
      fileName: () => 'dapp-provider.js',
    },
  },
  define: { 'process.env': {} },
});
