/** Product name and attribution notice for the active mobile brand. */
declare const __MOBILE_BRAND__: 'bcorp' | 'yours' | 'bwallet';

export const PRODUCT_NAME =
  __MOBILE_BRAND__ === 'bcorp' ? 'bWallet' : __MOBILE_BRAND__ === 'bwallet' ? 'bWallet' : 'Yours Wallet Mobile';

export const UNOFFICIAL_NOTICE =
  __MOBILE_BRAND__ === 'bcorp'
    ? 'bWallet (beta) by The Bitcoin Corporation Ltd. Based on the open-source Yours Wallet (MIT licence); not affiliated with or endorsed by its authors.'
    : __MOBILE_BRAND__ === 'bwallet'
      ? 'bWallet is an experimental, unofficial fork of Yours Wallet — not affiliated with or endorsed by the Yours Wallet team.'
      : 'Yours Wallet Mobile is an experimental, unofficial build of Yours Wallet — not made, reviewed or endorsed by the Yours Wallet team.';
