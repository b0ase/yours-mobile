declare const __BWALLET_EXTENSION__: boolean | undefined;

/** True in the bWalletX Chrome extension build (vite.config.ts), which runs the mobile UI in Chrome's side panel. */
export const IS_EXTENSION: boolean = typeof __BWALLET_EXTENSION__ !== 'undefined' && __BWALLET_EXTENSION__ === true;
