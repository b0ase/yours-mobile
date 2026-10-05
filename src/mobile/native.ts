import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/**
 * YoursNative: the app's own native plugin (ios/App/App/YoursNativePlugin.swift,
 * android/.../YoursNativePlugin.java). Kept in-repo rather than using third-party
 * plugins because it holds the keystore and the biometric-protected passKey.
 *
 * - secure*: Keychain (ThisDeviceOnly, excluded from backups) / Android Keystore-wrapped prefs.
 * - biometric*: an item readable only after Face ID / Touch ID / fingerprint.
 * - browser*: in-app browser for dApps; native supplies each request's origin.
 */

export type BiometryType = 'faceId' | 'touchId' | 'opticId' | 'fingerprint' | 'none';

export type BrowserRequest = {
  requestId: string;
  /** Trusted: from the native WebView's frame info, never from page script. */
  origin: string;
  url: string;
  payload: string;
};

export interface YoursNativePlugin {
  secureGet(opts: { key: string }): Promise<{ value: string | null }>;
  secureSet(opts: { key: string; value: string }): Promise<void>;
  secureRemove(opts: { key: string }): Promise<void>;
  secureKeys(): Promise<{ keys: string[] }>;

  biometricStatus(): Promise<{ available: boolean; biometryType: BiometryType }>;
  biometricSet(opts: { key: string; value: string }): Promise<void>;
  /** Rejects with code 'cancelled' if the user dismisses the prompt. */
  biometricGet(opts: { key: string; reason: string }): Promise<{ value: string | null }>;
  biometricRemove(opts: { key: string }): Promise<void>;

  browserOpen(opts: { url: string; provider: string }): Promise<void>;
  browserClose(): Promise<void>;
  browserSetHidden(opts: { hidden: boolean }): Promise<void>;
  browserRespond(opts: { requestId: string; response: string }): Promise<void>;
  /** Dispatch a provider event (account/network change) into the page. */
  browserEmit(opts: { event: string; detail: string }): Promise<void>;

  /** bWallet calls: route call audio to the loudspeaker (true) or the earpiece (false). */
  audioSetSpeaker(opts: { on: boolean }): Promise<void>;

  /** iOS: ASWebAuthenticationSession; resolves with the `<scheme>://…` URL it ended on, rejects 'cancelled'. */
  authSession(opts: { url: string; scheme: string; httpsHost?: string; httpsPath?: string }): Promise<{ url: string }>;

  addListener(event: 'browserRequest', fn: (req: BrowserRequest) => void): Promise<PluginListenerHandle>;
  addListener(event: 'browserClosed', fn: () => void): Promise<PluginListenerHandle>;
}

/** Browser-preview fallback: plain storage, no biometrics, links open in a tab. */
const web: Partial<YoursNativePlugin> = {
  async secureGet({ key }) {
    return { value: localStorage.getItem(`secure:${key}`) };
  },
  async secureSet({ key, value }) {
    localStorage.setItem(`secure:${key}`, value);
  },
  async secureRemove({ key }) {
    localStorage.removeItem(`secure:${key}`);
  },
  async secureKeys() {
    return {
      keys: Object.keys(localStorage)
        .filter((k) => k.startsWith('secure:'))
        .map((k) => k.slice(7)),
    };
  },
  async biometricStatus() {
    return { available: false, biometryType: 'none' };
  },
  async biometricRemove() {},
  async browserOpen({ url }) {
    window.open(url, '_blank', 'noopener');
  },
  async browserClose() {},
  async browserSetHidden() {},
  async browserRespond() {},
  async browserEmit() {},
  async audioSetSpeaker() {},
};

export const YoursNative = registerPlugin<YoursNativePlugin>('YoursNative', {
  web: () => web as YoursNativePlugin,
});

export const isNative = Capacitor.isNativePlatform();
