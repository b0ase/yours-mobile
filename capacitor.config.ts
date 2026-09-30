import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // bCorp Wallet by The Bitcoin Corporation Ltd, based on the open-source Yours Wallet (MIT).
  // The ID never changes; the visible brand is set by scripts/set-brand.sh.
  appId: 'com.bitcoincorp.bcorpwallet',
  appName: 'bCorp Wallet',
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
