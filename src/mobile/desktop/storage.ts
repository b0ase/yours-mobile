import type { LocalBackend } from '../hub';

/**
 * bWalletX Desktop's storage.local: a key → JSON-string map held by the Rust side (src-tauri/src/store.rs) in one
 * owner-only file (0600) in the app data dir, rewritten atomically (temp file, fsync, rename) on every change batch.
 * The webview's own storage is never used for it, so clearing site data or a webview reset cannot take the keystore.
 */
export type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export const STORE_LOAD = 'store_load';
export const STORE_APPLY = 'store_apply';

export const tauriLocalBackend = (invoke: Invoke): LocalBackend => ({
  async load() {
    const entries = await invoke<Record<string, string> | null>(STORE_LOAD);
    return entries ?? {};
  },
  async apply(sets, removes) {
    if (Object.keys(sets).length === 0 && removes.length === 0) return;
    await invoke<void>(STORE_APPLY, { sets, removes });
  },
});

/**
 * Key-by-key view of the same store for YoursNative's secure* calls (biometric flags and the like), sharing one
 * loaded copy. Writes go straight through; the Rust side serialises them.
 */
export const tauriSecureStore = (invoke: Invoke) => {
  let cache: Promise<Map<string, string>> | null = null;
  const loaded = () =>
    (cache ??= invoke<Record<string, string> | null>(STORE_LOAD).then((e) => new Map(Object.entries(e ?? {}))));
  return {
    async get(key: string): Promise<string | null> {
      return (await loaded()).get(key) ?? null;
    },
    async set(key: string, value: string) {
      const m = await loaded();
      await invoke<void>(STORE_APPLY, { sets: { [key]: value }, removes: [] });
      m.set(key, value);
    },
    async remove(key: string) {
      const m = await loaded();
      await invoke<void>(STORE_APPLY, { sets: {}, removes: [key] });
      m.delete(key);
    },
    async keys(): Promise<string[]> {
      return [...(await loaded()).keys()];
    },
  };
};
