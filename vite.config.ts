import { defineConfig, mergeConfig, type Plugin } from 'vite';
import baseConfig from './vite.config.base';
import { brand, bcorpText, bcorpColours, EXTENSION_TEXT } from './vite.brand';
import { MOBILE_DEFINES, MOBILE_SWAPS, mobileText } from './vite.config.mobile';

/**
 * bWalletX Chrome extension pages: the full mobile UI (tabs, Market, Media, Chat, b agent...) on the real
 * chrome.* APIs and background service worker, so sites still connect through content.js / inject.js.
 * It opens in Chrome's side panel (scripts/build.ts), which is phone-shaped. Not a store build.
 */
const EXTENSION_SWAPS: Record<string, string> = {
  ...MOBILE_SWAPS,
  // The mobile entry (src/mobile/main.ts) isn't used: no chrome shim, hub or overlay frames here.
};

// Every extension page gets the mobile stylesheet (full-height layout, Obsidian UI).
const extensionCss = (): Plugin => ({
  name: 'bwalletx-extension-css',
  transformIndexHtml: {
    order: 'pre',
    handler: (html) =>
      html.replace('</head>', '    <link rel="stylesheet" href="./src/mobile/extension.css" />\n  </head>'),
  },
});

export default mergeConfig(
  baseConfig,
  defineConfig({
    plugins: [brand(EXTENSION_SWAPS, { emitAvatar: true }), mobileText(), bcorpText(EXTENSION_TEXT), bcorpColours(), extensionCss()],
    define: { ...MOBILE_DEFINES, __BWALLET_EXTENSION__: 'true' },
  }),
);
