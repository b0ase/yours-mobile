// Upstream constants with bWallet's default account avatar (swapped in by
// vite.config.mobile.ts). The local export overrides the re-exported one.
//
// The avatar URL is persisted into each new account, so it must not change
// between builds: vite.config.mobile.ts emits the file at this fixed,
// unhashed path. Relative, so it resolves against whichever page shows it.
export * from '../../utils/constants';
export const HOSTED_YOURS_IMAGE = 'bwallet-avatar.png';

// Upstream's DEFAULT_ACCOUNT captured its own HOSTED_YOURS_IMAGE when that module
// loaded, so re-exporting it would still give new accounts the Yours avatar.
import { DEFAULT_ACCOUNT as upstreamDefaultAccount } from '../../utils/constants';
export const DEFAULT_ACCOUNT = {
  ...upstreamDefaultAccount,
  settings: {
    ...upstreamDefaultAccount.settings,
    socialProfile: { ...upstreamDefaultAccount.settings.socialProfile, avatar: HOSTED_YOURS_IMAGE },
  },
  icon: HOSTED_YOURS_IMAGE,
};

// Rebranded builds don't feature upstream's own site (name + logo) in the app list.
import { featuredApps as upstreamFeaturedApps } from '../../utils/constants';
export const featuredApps = upstreamFeaturedApps.filter((app) => app.link !== 'https://yours.org');
