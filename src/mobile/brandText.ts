/** Product name and attribution notice for the active mobile brand. */
declare const __BRAND__: 'bcorp' | 'yours' | 'bwallet';

export const PRODUCT_NAME =
  __BRAND__ === 'bcorp' ? 'bWallet' : __BRAND__ === 'bwallet' ? 'bWallet' : 'Yours Wallet Mobile';

export const UNOFFICIAL_NOTICE =
  __BRAND__ === 'bcorp'
    ? 'bWallet (beta) by The Bitcoin Corporation Ltd. Based on the open-source Yours Wallet (MIT licence); not affiliated with or endorsed by its authors.'
    : __BRAND__ === 'bwallet'
      ? 'bWallet is an experimental, unofficial fork of Yours Wallet — not affiliated with or endorsed by the Yours Wallet team.'
      : 'Yours Wallet Mobile is an experimental, unofficial build of Yours Wallet — not made, reviewed or endorsed by the Yours Wallet team.';
