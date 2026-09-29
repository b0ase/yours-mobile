// Upstream constants with bWallet's default account avatar (swapped in by
// vite.config.mobile.ts). The local export overrides the re-exported one.
//
// The avatar URL is persisted into each new account, so it must not change
// between builds: vite.config.mobile.ts emits the file at this fixed,
// unhashed path. Relative, so it resolves against whichever page shows it.
export * from '../../utils/constants';
export const HOSTED_YOURS_IMAGE = 'bwallet-avatar.png';
