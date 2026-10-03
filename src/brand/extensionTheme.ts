import { theme as upstream } from '../theme';
import type { Theme } from '../theme.types';

/**
 * bWalletX extension theme (the extension is a full-feature, non-store build). vite.brand.ts swaps this in for src/theme.ts in the
 * extension build (BRAND=bcorp or bwallet). Unlike the mobile theme it leaves
 * out the in-app Browser tab, which only the mobile shell can host.
 */
export const theme: Theme = {
  ...upstream,
  settings: {
    ...upstream.settings,
    walletName: 'bWalletX',
    displayName: 'bWalletX',
    badge: 'Beta',
    repo: 'https://github.com/b0ase/yours-mobile',
  },
};
