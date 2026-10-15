import { theme as upstream } from '../../theme';
import type { Theme } from '../../theme.types';
import { appNameFor } from '../storeBuild';

/**
 * Mobile theme. vite.config.mobile.ts swaps this in for src/theme.ts.
 * MOBILE_BRAND=bcorp (default) is "bWallet" in store builds and "bWalletX" otherwise (storeBuild.appNameFor); bwallet is "bWallet"; yours
 * keeps upstream's name. bcorp/bwallet also swap logos and the default avatar.
 */
declare const __BRAND__: 'bcorp' | 'yours' | 'bwallet';

export const theme: Theme = {
  ...upstream,
  // Obsidian UI: pure black canvas and tab bar. Theme packs (src/mobile/theme/accents.ts) restyle these through
  // CSS variables; the fallbacks are today's colours, so Gold (which sets none) is unchanged. vite.theme.ts turns
  // upstream's `colour + 'aa'` alpha suffixes into color-mix() so a variable can sit here.
  color: {
    ...upstream.color,
    component: {
      ...upstream.color.component,
      bottomMenuBackground: 'var(--bw-nav, #000000)',
      bottomMenuText: 'var(--bw-text, #FFFFFF)',
      pageLoaderText: 'var(--bw-text, #FFFFFF)',
      tabUnselected: 'var(--bw-card, #17191E)',
      tabUnselectedText: 'var(--bw-text, #FFFFFF)',
      ordinalTypeUnsupported: 'var(--bw-text, #FFFFFF)',
      snackbarError: 'var(--bw-danger, #FF4646)',
      warningButton: 'var(--bw-danger, #FF4646)',
    },
    global: {
      ...upstream.color.global,
      walletBackground: 'var(--bw-pack-bg, #000000)',
      row: 'var(--bw-card, #17191E)',
      gray: 'var(--bw-muted, #98A2B3)',
      contrast: 'var(--bw-text, #FFFFFF)',
    },
  },
  settings: {
    ...upstream.settings,
    ...(__BRAND__ === 'bcorp'
      ? { walletName: appNameFor(), displayName: appNameFor() }
      : __BRAND__ === 'bwallet'
        ? { walletName: 'bWallet', displayName: 'bWallet' }
        : { displayName: 'Yours Wallet Mobile' }),
    badge: __BRAND__ === 'bcorp' ? 'Beta' : 'Experimental',
    repo: 'https://github.com/bitcoin-corp/bwallet',
    services: { ...upstream.settings.services, browser: true },
  },
};
