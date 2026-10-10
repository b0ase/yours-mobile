/* eslint-disable @typescript-eslint/no-explicit-any */
import { startRoute } from '../calls/popout';
import { YoursEventName } from '../../inject';
import type { YoursNativePlugin } from '../native';

/**
 * "Forgot password": remove the wallet stored on this device so it can be
 * restored from its recovery phrase. Mirrors upstream's Settings sign-out
 * (chrome.storage.local.clear + SIGNED_OUT, whose background handler drops the
 * wallet context, clears the passKey and deletes IndexedDB), plus the mobile
 * extras: the biometric-sealed passKey and its flags. No crypto here.
 */

const RESTORE_FLAG = 'bwallet:open-restore';
export const RESTORE_ROUTE = '/restore-wallet';

type Deps = {
  chrome: any;
  native: Pick<YoursNativePlugin, 'biometricRemove' | 'secureKeys' | 'secureRemove'>;
  idb?: Pick<IDBFactory, 'databases' | 'deleteDatabase'>;
  session?: Pick<Storage, 'setItem'>;
  /** Also flagged here: the restore screen may open in another page (a new extension tab, the app behind an overlay). */
  local?: Pick<Storage, 'setItem'>;
  wait?: (ms: number) => Promise<void>;
  /** Open the restore screen after the reload (Forgot password). Account deletion passes false. */
  restore?: boolean;
};

const deleteDb = (idb: Pick<IDBFactory, 'deleteDatabase'>, name: string) =>
  new Promise<void>((resolve) => {
    const req = idb.deleteDatabase(name);
    const done = () => resolve();
    req.onsuccess = done;
    req.onerror = done;
    // Still open somewhere: the delete completes once it closes; don't hang the UI.
    req.onblocked = () => setTimeout(done, 1500);
  });

export const wipeLocalWallet = async ({
  chrome,
  native,
  idb = indexedDB,
  session = sessionStorage,
  local = globalThis.localStorage,
  wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  restore = true,
}: Deps): Promise<void> => {
  // Biometrics first, so the old passKey can't come back even if a later step fails.
  await native.biometricRemove({ key: '' }).catch(() => undefined);
  const { keys } = await native.secureKeys().catch(() => ({ keys: [] as string[] }));
  for (const key of keys.filter((k) => k.startsWith('bio:'))) {
    await native.secureRemove({ key }).catch(() => undefined);
  }

  // Upstream sign-out (Settings.tsx): clear local storage, tell the background.
  await chrome.storage.local.clear();
  await chrome.storage.session?.clear?.().catch?.(() => undefined);
  chrome.runtime.sendMessage({ action: YoursEventName.SIGNED_OUT }, () => void chrome.runtime.lastError);
  await wait(300);

  // The background deletes IndexedDB too, but a reload stops its worker; do it here
  // as well and wait. Same filter as background.ts (block header DBs are shared data).
  const dbs = (await idb.databases?.().catch(() => [])) ?? [];
  for (const db of dbs) {
    if (!db.name || db.name.startsWith('block')) continue;
    await deleteDb(idb, db.name);
  }

  if (!restore) return;
  for (const store of [session, local]) {
    try {
      store.setItem(RESTORE_FLAG, '1');
    } catch {
      /* falls back to the Start screen, which also offers Restore */
    }
  }
};

type OpenEnv = {
  location: Pick<Location, 'pathname' | 'protocol' | 'reload'>;
  self: Window;
  top: Window | null;
  close: () => void;
  chrome?: any;
};

/**
 * After the wipe, open the restore screen in the wallet itself. The unlock screen with this button is also the
 * approval page (prompt.html): a popup window or in-page sheet in the extension (a site asking to sign in, e.g.
 * bChatX, while the wallet is locked), an overlay frame over the wallet on the phone and the web wallet. Reloading
 * that page only closed it (owner, 9 Oct 2026: "the restore button isn't working at all"), so from there:
 * reload the wallet page behind the overlay, or open the wallet in a tab and close the prompt.
 */
export const openRestore = (env: OpenEnv): void => {
  if (!/\/prompt\.html$/.test(env.location.pathname)) {
    env.location.reload();
    return;
  }
  if (env.top && env.top !== env.self) {
    try {
      env.top.location.reload(); // same-origin overlay frame (phone app, web wallet)
      return;
    } catch {
      /* cross-origin: the extension's in-page sheet over a site */
    }
  }
  if (env.location.protocol === 'chrome-extension:' && env.chrome?.tabs?.create) {
    void Promise.resolve(env.chrome.tabs.create({ url: env.chrome.runtime.getURL('index.html') })).catch(
      () => undefined,
    );
    void Promise.resolve(env.chrome.runtime.sendMessage({ action: 'DISMISS_PROMPT_PANEL' })).catch(() => undefined);
    env.close();
    return;
  }
  env.location.reload();
};

/** MemoryRouter's first entry: the restore screen once, right after a wipe. */
export const initialRoute = (): string => {
  let restore = false;
  for (const name of ['sessionStorage', 'localStorage'] as const) {
    try {
      const store = globalThis[name];
      if (store?.getItem(RESTORE_FLAG)) {
        store.removeItem(RESTORE_FLAG);
        restore = true;
      }
    } catch {
      /* no storage */
    }
  }
  // The extension's popped-out Calls window opens on /m/calls (calls/popout.ts).
  return restore ? RESTORE_ROUTE : startRoute();
};
