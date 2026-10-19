/**
 * Phone owner check for Change password (security audit 19 Oct 2026): Face ID / Touch ID / fingerprint OR the phone's
 * passcode, via the YoursNative plugin. Loaded lazily so the extension's service worker never pulls in Capacitor.
 */
// No static @capacitor/core import (a service worker must not load it): the native shell injects globalThis.Capacitor.
export const canDeviceOwnerAuth = (): boolean =>
  (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.() === true;

export const deviceOwnerAuth = async (reason: string): Promise<boolean> => {
  if (!canDeviceOwnerAuth()) return false;
  const { YoursNative } = await import('./native');
  if (!YoursNative.deviceOwnerAuth) return false;
  const r = await YoursNative.deviceOwnerAuth({ reason }).catch(() => ({ ok: false }));
  return r?.ok === true;
};
