import { theme as upstream } from '../../theme';
import type { Theme } from '../../theme.types';

/**
 * Mobile theme. vite.config.mobile.ts swaps this in for src/theme.ts.
 * MOBILE_BRAND=yours (default) keeps upstream's name; bwallet renames it (and
 * the build also swaps logos and the default avatar).
 */
declare const __MOBILE_BRAND__: 'yours' | 'bwallet';

export const theme: Theme = {
  ...upstream,
  settings: {
    ...upstream.settings,
    ...(__MOBILE_BRAND__ === 'bwallet'
      ? { walletName: 'bWallet', displayName: 'bWallet' }
      : { displayName: 'Yours Wallet Mobile' }),
    badge: 'Experimental',
    repo: 'https://github.com/b0ase/yours-mobile',
    services: { ...upstream.settings.services, browser: true },
  },
};
