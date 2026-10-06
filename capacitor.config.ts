import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // bWallet by The Bitcoin Corporation Ltd, based on the open-source Yours Wallet (MIT).
  // The ID never changes; the visible brand is set by scripts/set-brand.sh.
  appId: 'com.bitcoincorp.bwallet',
  appName: 'bWallet',
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
    // In the foreground the app's own poller (src/mobile/notify) already tells you; push is for when it's closed.
    PushNotifications: {
      presentationOptions: [],
    },
  },
};

export default config;
