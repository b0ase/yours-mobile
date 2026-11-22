/**
 * The background's controls for our storage server (reviews of 6888544a and a95a1ff0): one place that decides
 *  - whether a store switch may make a remote active (Settings › Storage "Make active", and the switch inside a
 *    restore): our server only with the flag on and this device's 'repaired' record (its whole fill ran here);
 *  - which remote a restore, a repair or a reconcile reads from: never our server while it is held out, or with the
 *    flag off, unless it is the account's active store;
 *  - which remotes Settings › Storage shows as not makeable active, with why;
 *  - and what sign-out forgets.
 * background.ts builds its handlers from these (ourServerControls.test.ts checks both).
 */
import { makeActiveRefusal } from './spendableFirstWiring';
import { forgetDeviceStoreRecords, normalizeStoreConfig, repairSyncRemote, SNAPSHOT_MARK_KEY } from './spendableFirst';
import type { StoreConfig } from './ourServer';

type KvGet = { get(key: string): Promise<Record<string, unknown> | undefined> };
/** The open wallet, as far as these rules need it (initWallet's AccountContext). */
type OpenWallet = { deviceStoreKey(): string | undefined; ourBackupHeldOut(): boolean };

export function ourServerControls(d: {
  flagOn: () => Promise<boolean>;
  kv: KvGet;
  identityAddress: () => string | undefined;
  ctx: () => OpenWallet | null | undefined;
}) {
  /** Why `url` can't be made active (our server not whole on this device), else undefined. */
  const refusal = async (url: string): Promise<string | undefined> => {
    const id = d.identityAddress();
    const ctx = d.ctx();
    return makeActiveRefusal(url, {
      flagOn: await d.flagOn(),
      kv: d.kv,
      markKey: SNAPSHOT_MARK_KEY(id ?? ''),
      deviceSik: id && ctx ? ctx.deviceStoreKey() : undefined,
    });
  };
  return {
    refusal,
    /** A store switch that refuses (throws the plain line) before switching to a remote it may not make active. */
    guardSetActive:
      <T>(setActive: (target: string) => Promise<T>) =>
      async (target: string): Promise<T> => {
        if (target !== 'local') {
          const why = await refusal(target);
          if (why) throw new Error(why);
        }
        return setActive(target);
      },
    /** The remote a restore, repair or reconcile reads from. No wallet open: never our server. */
    pickRemote: async (config: StoreConfig | undefined): Promise<string | undefined> =>
      repairSyncRemote(normalizeStoreConfig(config), d.ctx()?.ourBackupHeldOut() ?? true, await d.flagOn()),
    /** STORAGE_GET_INFO: each saved remote whose Make active is refused, with why. */
    refusedActive: async (config: StoreConfig | undefined): Promise<Record<string, string>> => {
      const out: Record<string, string> = {};
      for (const url of config?.remotes ?? []) {
        const why = await refusal(url);
        if (why) out[url] = why;
      }
      return out;
    },
  };
}

/**
 * Sign-out: the wallet dropped, the pass key cleared, the stores deleted, then the install's storage identity key and
 * every repair record forgotten (review of 6888544a, 3), in storage and in the loaded copy.
 */
export async function signOutStores(d: {
  dropWallet: () => void;
  clearPassKey: () => Promise<void>;
  deleteDatabases: () => Promise<void>;
  area: Parameters<typeof forgetDeviceStoreRecords>[0];
  cache: () => { storageIdentityKey?: string } | null | undefined;
  log?: (...a: unknown[]) => void;
}): Promise<void> {
  d.dropWallet();
  await d.clearPassKey();
  await d.deleteDatabases();
  await forgetDeviceStoreRecords(d.area).catch((e) =>
    (d.log ?? console.warn)('[signOut] could not forget the store records:', e),
  );
  const cache = d.cache();
  if (cache) delete cache.storageIdentityKey;
}
