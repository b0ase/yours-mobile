import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { YoursNativePlugin } from '../native';
import { detectTauri } from '../webApp';
import { tauriSecureStore, type Invoke } from './storage';

/** True inside bWalletX Desktop (src-tauri/). Decided once: the Tauri globals exist before any module runs. */
export const IS_TAURI = detectTauri();

export const invoke: Invoke = (cmd, args) => tauriInvoke(cmd, args);

/**
 * YoursNative on Desktop: the phone plugin's secure* and biometric* calls, answered by the Rust side.
 * - secure*: the same owner-only store file as storage.local (src-tauri/src/store.rs).
 * - biometric*: values sealed in the macOS Keychain, released only after a Touch ID (or login password) check
 *   (src-tauri/src/bio.rs). biometricRemove({ key: '' }) clears every sealed value, as on the phones.
 */
export const tauriNative = (call: Invoke = invoke): Partial<YoursNativePlugin> => {
  const store = tauriSecureStore(call);
  return {
    async secureGet({ key }) {
      return { value: await store.get(key) };
    },
    async secureSet({ key, value }) {
      await store.set(key, value);
    },
    async secureRemove({ key }) {
      await store.remove(key);
    },
    async secureKeys() {
      return { keys: await store.keys() };
    },
    async biometricStatus() {
      const s = await call<{ available: boolean; biometryType: 'touchId' | 'none' }>('bio_status');
      return { available: s.available, biometryType: s.biometryType };
    },
    async biometricSet({ key, value }) {
      await call<void>('bio_set', { key, value });
    },
    async biometricGet({ key, reason }) {
      try {
        return { value: await call<string | null>('bio_get', { key, reason }) };
      } catch (e) {
        // Same shape as the phone plugins: a dismissed prompt rejects with code 'cancelled'.
        const msg = String(e);
        throw Object.assign(new Error(msg), { code: /cancel/i.test(msg) ? 'cancelled' : 'error' });
      }
    },
    async biometricRemove({ key }) {
      await call<void>('bio_remove', { key });
    },
    async browserOpen({ url }) {
      await openExternal(url, call);
    },
  };
};

/** Links leave the app for the default browser: https/http/mailto only (src-tauri/src/lib.rs re-checks). */
export const openExternal = async (url: string, call: Invoke = invoke) => {
  await call<void>('open_external', { url });
};
