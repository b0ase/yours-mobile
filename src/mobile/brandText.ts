/** Product name and "unofficial" notice for the active mobile brand. */
declare const __MOBILE_BRAND__: 'yours' | 'bwallet';

export const PRODUCT_NAME = __MOBILE_BRAND__ === 'bwallet' ? 'bWallet' : 'Yours Wallet Mobile';

export const UNOFFICIAL_NOTICE =
  __MOBILE_BRAND__ === 'bwallet'
    ? 'bWallet is an experimental, unofficial fork of Yours Wallet — not affiliated with or endorsed by the Yours Wallet team.'
    : 'Yours Wallet Mobile is an experimental, unofficial build of Yours Wallet — not made, reviewed or endorsed by the Yours Wallet team.';
