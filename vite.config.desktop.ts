import { defineConfig, mergeConfig, type Plugin } from 'vite';
import mobileConfig from './vite.config.mobile';

/**
 * bWalletX Desktop (Tauri, src-tauri/): the mobile build in the wide layout, loaded from build-desktop/ by the Tauri
 * webview at a fixed origin (tauri://localhost), so the wallet-toolbox IndexedDB stays put across launches.
 * storage.local (the password-encrypted keystore) does not live in the webview: hub.ts hands it to the Rust side
 * (src/mobile/desktop/storage.ts → src-tauri/src/store.rs), an owner-only file in the app data dir.
 *
 * Run through `pnpm build:desktop`, which sets VITE_WIDE_WEB=1 and VITE_CHANNEL=desktop in the environment before
 * vite.config.mobile.ts is evaluated (it reads both at import time).
 */
if (process.env.VITE_WIDE_WEB !== '1' || process.env.VITE_CHANNEL !== 'desktop') {
  throw new Error('vite.config.desktop.ts: run it via `pnpm build:desktop` (VITE_WIDE_WEB=1 VITE_CHANNEL=desktop).');
}

const desktopShell = (): Plugin => ({
  name: 'bwallet-desktop-shell',
  transformIndexHtml: {
    order: 'post',
    handler(html, ctx) {
      if (!ctx.filename.endsWith('mobile.html')) return html;
      return html.replace(/<title>[^<]*<\/title>/, '<title>bWalletX Desktop</title>');
    },
  },
});

export default mergeConfig(
  mobileConfig,
  defineConfig({
    plugins: [desktopShell()],
    // The Tauri asset server serves index.html for unknown paths; absolute asset URLs keep deep paths working.
    base: '/',
    build: { outDir: 'build-desktop', sourcemap: false },
  }),
);
