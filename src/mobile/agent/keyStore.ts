import { YoursNative } from '../native';
import type { ProviderId } from './providers';

/**
 * The user's own provider keys, one per provider, in the device's secure storage: iOS Keychain
 * (this device only, not backed up) / Android Keystore via the app's own YoursNative plugin. In a
 * desktop browser preview it falls back to localStorage (development only).
 * Keys are read only right before a provider call and are never sent to bCorp or logged.
 */
const slot = (p: ProviderId) => `agent:key:${p}`;

export const loadKey = async (p: ProviderId): Promise<string | null> => {
  try {
    return (await YoursNative.secureGet({ key: slot(p) })).value || null;
  } catch {
    return null;
  }
};
export const saveKey = (p: ProviderId, key: string) => YoursNative.secureSet({ key: slot(p), value: key.trim() });
export const deleteKey = (p: ProviderId) => YoursNative.secureRemove({ key: slot(p) });
export const hasKey = async (p: ProviderId) => !!(await loadKey(p));

/** Shown in Settings instead of the key: its first and last few characters. */
export const maskKey = (key: string): string => {
  const k = key.trim();
  return k.length <= 10 ? '•'.repeat(Math.max(k.length, 4)) : `${k.slice(0, 5)}…${k.slice(-4)}`;
};
