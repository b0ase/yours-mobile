import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { resolve } from 'path';
import { brandDefines, extensionBrandPlugins } from './vite.brand';

// Inject script config - IIFE format (runs in page context)
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
    alias: [
      { find: 'path', replacement: 'path-browserify' },
      // Only the CWI event bridge is needed here: the package root pulls in the whole wallet (~0.9 MB in a
      // script that runs on every page). Its cwi/ folder is self-contained (no imports outside it).
      {
        find: /^@1sat\/wallet-browser$/,
        replacement: resolve(__dirname, 'node_modules/@1sat/wallet/dist/cwi/index.js'),
      },
    ],
    preserveSymlinks: true,
  },
  logLevel: 'error',
  build: {
    outDir: 'build',
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/inject.ts'),
      name: 'inject',
      formats: ['iife'],
      fileName: () => 'inject.js',
    },
    rollupOptions: {
      output: {
        extend: true,
      },
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
