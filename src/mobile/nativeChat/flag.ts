import { Capacitor } from '@capacitor/core';
import { STORE_BUILD } from '../storeBuild';

/**
 * The native iPhone chat switch (owner, 8 Nov 2026: "the MAIN THING is SPEED of opening rooms").
 * OFF by default: with it off nothing in nativeChat/ loads and Chat is the WebView it has always been.
 *
 * On when, and only when, this is the iOS app, not a store build, and either
 *   - localStorage `bwallet:native-chat` is '1' (this device), or
 *   - the build set VITE_NATIVE_CHAT=1 and this device has not said '0'.
 */
export const NATIVE_CHAT_KEY = 'bwallet:native-chat';

export const nativeChatSwitch = (s: {
  platform: string;
  store: boolean;
  stored: string | null;
  build: string | undefined;
}): boolean => {
  if (s.platform !== 'ios' || s.store) return false;
  if (s.stored === '1') return true;
  if (s.stored === '0') return false;
  return s.build === '1';
};

const stored = (): string | null => {
  try {
    return localStorage.getItem(NATIVE_CHAT_KEY);
  } catch {
    return null;
  }
};

export const nativeChatEnabled = (): boolean =>
  nativeChatSwitch({
    platform: Capacitor.getPlatform(),
    store: STORE_BUILD,
    stored: stored(),
    build: import.meta.env.VITE_NATIVE_CHAT as string | undefined,
  });
