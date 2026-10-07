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
  // Obsidian UI: pure black canvas and tab bar.
  color: {
    ...upstream.color,
    component: { ...upstream.color.component, bottomMenuBackground: '#000000' },
    global: { ...upstream.color.global, walletBackground: '#000000' },
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
