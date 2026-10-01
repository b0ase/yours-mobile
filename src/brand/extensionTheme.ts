import { theme as upstream } from '../theme';
import type { Theme } from '../theme.types';

/**
 * bWallet extension theme. vite.brand.ts swaps this in for src/theme.ts in the
 * extension build (BRAND=bcorp or bwallet). Unlike the mobile theme it leaves
 * out the in-app Browser tab, which only the mobile shell can host.
 */
export const theme: Theme = {
  ...upstream,
  settings: {
    ...upstream.settings,
    walletName: 'bWallet',
    displayName: 'bWallet',
    badge: 'Beta',
    repo: 'https://github.com/b0ase/yours-mobile',
  },
};
