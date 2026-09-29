import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // bWallet: an unofficial fork of Yours Wallet, published by The Bitcoin Corporation.
  appId: 'com.bitcoincorp.bwallet',
  appName: 'Yours Wallet Mobile',
  webDir: 'build-mobile',
  backgroundColor: '#010101',
  // Never log bridge calls: their arguments include keystore values and the passKey.
  loggingBehavior: 'none',
  ios: {
    contentInset: 'never',
    limitsNavigationsToAppBoundDomains: false,
  },
  android: {
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 800,
      backgroundColor: '#010101',
      showSpinner: false,
    },
  },
};

export default config;
