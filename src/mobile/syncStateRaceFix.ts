import { StorageIdb } from '@bsv/wallet-toolbox-client';

/**
 * wallet-toolbox's findOrInsertSyncStateAuth is find-then-insert in separate
 * IndexedDB transactions. When two callers run it at once (wallet init and the
 * initial monitor/backup sync), both find nothing and both insert, leaving two
 * sync_states rows for the same storage. Every later call then throws
 * "Result must be unique" and the wallet never initialises. WebKit's IndexedDB
 * timing hits this on every start; Chrome's usually doesn't.
 *
 * Serialise calls per (user, storage) and, if duplicates already exist, keep the
 * oldest row and delete the rest.
 */
type Auth = { userId?: number };
type SyncState = { syncStateId: number };
type FindOrInsert = (
  this: StorageIdb,
  auth: Auth,
  storageIdentityKey: string,
  storageName: string,
) => Promise<{ syncState: SyncState; isNew: boolean }>;

const proto = StorageIdb.prototype as unknown as {
  findOrInsertSyncStateAuth: FindOrInsert;
  findSyncStates: (args: { partial: Record<string, unknown> }) => Promise<SyncState[]>;
};
const original = proto.findOrInsertSyncStateAuth;
const queues = new WeakMap<object, Map<string, Promise<unknown>>>();

proto.findOrInsertSyncStateAuth = function (auth, storageIdentityKey, storageName) {
  let perStore = queues.get(this);
  if (!perStore) queues.set(this, (perStore = new Map()));
  const key = `${auth.userId}|${storageIdentityKey}|${storageName}`;

  const run = async () => {
    const rows = await proto.findSyncStates.call(this, {
      partial: { userId: auth.userId, storageIdentityKey, storageName },
    });
    if (rows.length > 1) {
      // Other lookups (processSyncChunk) also require a single row, so delete
      // the extras rather than just picking one.
      rows.sort((a, b) => a.syncStateId - b.syncStateId);
      const db = (this as unknown as { db?: { delete: (store: string, id: number) => Promise<void> } }).db;
      if (db) for (const extra of rows.slice(1)) await db.delete('sync_states', extra.syncStateId);
      console.warn(`[syncStateRaceFix] ${rows.length} sync_states for ${storageName}; kept #${rows[0].syncStateId}`);
      return { syncState: rows[0], isNew: false };
    }
    return original.call(this, auth, storageIdentityKey, storageName);
  };

  const next = (perStore.get(key) ?? Promise.resolve()).catch(() => {}).then(run);
  perStore.set(key, next);
  return next;
};
