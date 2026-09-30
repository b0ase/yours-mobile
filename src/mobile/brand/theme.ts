import { theme as upstream } from '../../theme';
import type { Theme } from '../../theme.types';

/**
 * Mobile theme. vite.config.mobile.ts swaps this in for src/theme.ts.
 * MOBILE_BRAND=bcorp (default) is "bWallet"; bwallet is "bWallet"; yours
 * keeps upstream's name. bcorp/bwallet also swap logos and the default avatar.
 */
declare const __MOBILE_BRAND__: 'bcorp' | 'yours' | 'bwallet';

export const theme: Theme = {
  ...upstream,
  settings: {
    ...upstream.settings,
    ...(__MOBILE_BRAND__ === 'bcorp'
      ? { walletName: 'bWallet', displayName: 'bWallet' }
      : __MOBILE_BRAND__ === 'bwallet'
        ? { walletName: 'bWallet', displayName: 'bWallet' }
        : { displayName: 'Yours Wallet Mobile' }),
    badge: __MOBILE_BRAND__ === 'bcorp' ? 'Beta' : 'Experimental',
    repo: 'https://github.com/b0ase/yours-mobile',
    services: { ...upstream.settings.services, browser: true },
  },
};
