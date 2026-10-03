/**
 * Release channel, chosen at build time with VITE_CHANNEL (scripts/channel-build.sh):
 *
 *   ios-store       App Store            com.bitcoincorp.bwallet          store rules (storeBuild.ts)
 *   ios-private     Ad Hoc / EU direct   com.bitcoincorp.bwalletx         everything on (bWalletX)
 *   android-play    Google Play          com.bitcoincorp.bwallet          store rules
 *   android-direct  APK from the site    com.bitcoincorp.bwallet.direct   everything on (bWalletX)
 *
 * Unset = 'dev' (local builds), which behaves like the private channels. Store rules key off
 * isStoreChannel; the app IDs and home-screen names are set natively (android/app/build.gradle
 * flavors, ios/App build settings).
 */
export type Channel = 'ios-store' | 'ios-private' | 'android-play' | 'android-direct' | 'dev';

export const CHANNELS: readonly Channel[] = ['ios-store', 'ios-private', 'android-play', 'android-direct'];

export const CHANNEL: Channel = (import.meta.env.VITE_CHANNEL as Channel | undefined) || 'dev';

export const isStoreChannel = (c: Channel = CHANNEL) => c === 'ios-store' || c === 'android-play';

/** "1.0.7 (android-direct)"; plain version for local dev builds. */
export const versionLabel = (version: string, c: Channel = CHANNEL) => (c === 'dev' ? version : `${version} (${c})`);
