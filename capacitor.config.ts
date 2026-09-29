import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // Must match the App ID registered in yours.org's Apple / Google developer accounts.
  appId: 'org.yours.wallet',
  appName: 'Yours Wallet',
  webDir: 'build-mobile',
  backgroundColor: '#010101',
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
