/**
 * Our storage server (bwalletx-storage): its URL and every check of it, with no heavy imports so the UI-side modules
 * (services/localFirst.ts) can use them too. Re-exported by services/spendableFirst.ts.
 */

import { APP_NAME } from '../mobile/storeBuild';

/** Our storage server (bwalletx-storage), a BACKUP beside 1Sat when the flag is on. */
export const SNAPSHOT_SERVER_URL = 'https://storage.bwalletx.com';

export type StoreConfig = { activeRemote?: string; remotes?: string[]; [k: string]: unknown };

const OUR_HOST = new URL(SNAPSHOT_SERVER_URL).hostname;
/**
 * Our server, in any spelling a saved remote or a typed URL could have (review of 6888544a, 2): the host parsed,
 * lowercased and percent-decoded (the URL parser), trailing dots stripped, the default port and any path ignored.
 * Every check for our server goes through this, never an exact string match.
 */
export function isOurServer(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    if (u.port !== '' && u.port !== (u.protocol === 'https:' ? '443' : '80')) return false;
    let host = u.hostname.toLowerCase();
    while (host.endsWith('.')) host = host.slice(0, -1);
    return host === OUR_HOST;
  } catch {
    return false;
  }
}
/**
 * A saved storage config as read: any spelling of our server becomes SNAPSHOT_SERVER_URL, listed once. Returns the
 * same object when nothing changes.
 */
export function normalizeStoreConfig<T extends StoreConfig | undefined>(config: T): T {
  if (!config) return config;
  const remotes = config.remotes;
  const active = config.activeRemote;
  const needs = isOurServer(active) ? active !== SNAPSHOT_SERVER_URL : false;
  const fix = remotes?.some((u) => isOurServer(u) && u !== SNAPSHOT_SERVER_URL);
  const dup = (remotes?.filter((u) => isOurServer(u)).length ?? 0) > 1;
  if (!needs && !fix && !dup) return config;
  const out: string[] = [];
  for (const u of remotes ?? []) {
    const v = isOurServer(u) ? SNAPSHOT_SERVER_URL : u;
    if (!out.includes(v)) out.push(v);
  }
  return {
    ...config,
    ...(active !== undefined ? { activeRemote: isOurServer(active) ? SNAPSHOT_SERVER_URL : active } : {}),
    ...(remotes ? { remotes: out } : {}),
  };
}
/**
 * The account's storage config with our server added as a BACKUP remote (README Phase 1): only with the flag on, and
 * only once this device's store is the active one (a remote-active account gets it when the restore moves it here,
 * so the toolbox's switch never copies one server into the other). Returns the same object when nothing changes.
 */
export function withSnapshotRemote<T extends StoreConfig | undefined>(config: T, on: boolean): T {
  if (!on || !config || config.activeRemote) return config;
  if (config.remotes?.some(isOurServer)) return config;
  return { ...config, remotes: [...(config.remotes ?? []), SNAPSHOT_SERVER_URL] };
}

/**
 * The remote STORAGE_REPAIR_SYNC reconciles with: the active one, else the first backup, never our server while it is
 * held out of the session for its one-time repair (review of 8ee88600, 5). Undefined: none.
 */
export function repairSyncRemote(
  config: StoreConfig | undefined,
  ourServerHeldOut: boolean,
  flagOn: boolean,
): string | undefined {
  if (config?.activeRemote) return config.activeRemote;
  // Flag off: our server is never connected (backupsFor), Repair Sync included (review of f42df01f, 4).
  return backupsFor(config?.remotes, flagOn)?.find((u) => !(ourServerHeldOut && isOurServer(u)));
}

/** Settings › Storage: our server is never added by hand (it joins only through its fill and hold-out). */
export const OUR_SERVER_ADD_REFUSAL = `This server is added by ${APP_NAME} itself once your backup to it is complete, so it cannot be added here.`;
/** Settings › Storage's add: the refusal for our server's URL in any spelling (review of f42df01f, 3), else undefined. */
export function addRemoteRefusal(url: string): string | undefined {
  return isOurServer(url) ? OUR_SERVER_ADD_REFUSAL : undefined;
}

/**
 * Sign-out (background signOut deletes the stores): the install's storage identity key and every one-time repair
 * record go too (review of 6888544a, 3), so a new store never inherits a 'repaired' record or a key it wasn't made with.
 */
export async function forgetDeviceStoreRecords(area: {
  get(keys: null): Promise<Record<string, unknown>>;
  remove(keys: string[]): Promise<void>;
}): Promise<void> {
  const all = await area.get(null);
  const keys = Object.keys(all ?? {}).filter((k) => k === 'storageIdentityKey' || k.endsWith(':ourBackupCheck'));
  if (keys.length) await area.remove(keys);
}

/**
 * The backups to connect: our server only with the flag on (review, 20 Nov 2026). An earlier session with the flag on
 * may have saved it in the account's remotes; with the flag off it is never connected or pushed to.
 */
export function backupsFor(urls: string[] | undefined, on: boolean): string[] | undefined {
  return on || !urls ? urls : urls.filter((u) => !isOurServer(u));
}
