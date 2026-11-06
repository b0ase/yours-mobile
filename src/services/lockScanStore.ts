/**
 * Which wallet store a "Find my locks" scan filed into (review 21 L3). The page keeps a "scanned" flag per account
 * in localStorage, which outlives the store it describes: remove the account and import the same 12 words, or have
 * iOS evict IndexedDB, and the store is new while the flag says "done". The flag is therefore tied to this value and
 * a different value means "scan again".
 *
 * Local store: its storageIdentityKey (per install) plus the moment this store first saw the account (the user row's
 * created_at), so a store recreated for the same account on the same install is a different store. Remote store
 * active: its storageIdentityKey (the remote keeps its own rows; a wiped device does not empty it).
 */
type UserRow = { created_at?: Date | string | number } | undefined;
export type FingerprintStorage = {
  getSettings(): { storageIdentityKey: string };
  isActiveStorageProvider(): boolean;
  runAsStorageProvider<T>(f: (sp: { findUserByIdentityKey(key: string): Promise<UserRow> }) => Promise<T>): Promise<T>;
};

export async function storeFingerprint(storage: FingerprintStorage, identityKey: string): Promise<string> {
  const id = storage.getSettings().storageIdentityKey;
  if (!storage.isActiveStorageProvider()) return `${id}|remote`;
  const born = await storage.runAsStorageProvider(
    async (sp) => (await sp.findUserByIdentityKey(identityKey))?.created_at,
  );
  return `${id}|${born != null ? new Date(born).toISOString() : 'none'}`;
}
