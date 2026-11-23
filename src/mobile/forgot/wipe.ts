/* eslint-disable @typescript-eslint/no-explicit-any */
import { startRoute } from '../calls/popout';
import { YoursEventName } from '../../inject';
import type { YoursNativePlugin } from '../native';
import { IS_EXTENSION } from '../extension';
import { CLOSE_FOR_RELOAD_ACTION, CLOSE_FOR_RELOAD_CAP_MS } from '../account/closeForReload';
import { settleWithin, within } from '../../utils/settleWithin';

/**
 * "Forgot password": remove the wallet stored on this device so it can be
 * restored from its recovery phrase. Mirrors upstream's Settings sign-out
 * (chrome.storage.local.clear + SIGNED_OUT, whose background handler drops the
 * wallet context, clears the passKey and deletes IndexedDB), plus the mobile
 * extras: the biometric-sealed passKey and its flags. No crypto here.
 *
 * DOM localStorage is cleared too (b-Aware report, 23 Oct 2026): it held the phone-pairing sessions (each with its
 * pairing ECDH key), the revoke queue, the agent report outbox, card and theme caches, and the next wallet restored
 * on the device reconnected the old pairings. Every origin this code runs on is the wallet's own (the Capacitor app,
 * the extension, web.bwalletx.com), so clear() is used rather than a prefix list that new keys could slip past.
 */

const RESTORE_FLAG = 'bwallet:open-restore';
export const RESTORE_ROUTE = '/restore-wallet';
/** Where the phone keeps storage.local: one secure item per key (mobile/hub.ts LOCAL_PREFIX). */
const LOCAL_PREFIX = 'chrome.storage.local:';
/** The hub's sessionStorage mirror of storage.session (it holds the unlock key; mobile/hub.ts SESSION_KEY). */
const SESSION_MIRROR = 'chrome.storage.session';

/**
 * Caps, so the wipe always ends (Delete account › "Remove the wallet from this phone" did nothing on the owner's
 * iPhone, 5.2.61 build 155): closeMs for the in-page wallet's close, dbMs per IndexedDB delete, stepMs for each other
 * native or storage call.
 */
export type WipeCaps = { closeMs: number; dbMs: number; stepMs: number };
export const WIPE_CAPS: WipeCaps = { closeMs: CLOSE_FOR_RELOAD_CAP_MS, dbMs: 3_000, stepMs: 8_000 };

/** The wallet's keys may still be on this device: the wipe failed and says so (the screen offers Try again). */
export class WipeError extends Error {}

type Deps = {
  chrome: any;
  native: Pick<YoursNativePlugin, 'biometricRemove' | 'secureKeys' | 'secureRemove'>;
  idb?: Pick<IDBFactory, 'databases' | 'deleteDatabase'>;
  session?: Pick<Storage, 'setItem'> & Partial<Pick<Storage, 'removeItem'>>;
  local?: Pick<Storage, 'clear'>;
  /** Close live pairing sockets and forget the sessions (pair/sessions.ts closeAllPairings). */
  closePairings?: () => Promise<void> | void;
  /**
   * Close the wallet's IndexedDB stores before they are deleted. On phones, the web wallet and Desktop the background
   * runs in this page and holds them open; WebKit then answers a deleteDatabase with nothing at all (not even
   * `blocked`) until they close. Default: the account switch's close (closeForReload.ts); none in the extension.
   */
  closeWallet?: () => unknown;
  wait?: (ms: number) => Promise<void>;
  /** Open the restore screen after the reload (Forgot password). Account deletion passes false. */
  restore?: boolean;
  /**
   * Remove every secure item on the device, not only the wallet's (Delete account: agent API keys, invite vaults,
   * sign-in tokens). Defaults to !restore.
   */
  everySecureItem?: boolean;
  caps?: Partial<WipeCaps>;
};

/** Resolves on success, error or (after `ms`) when the delete never answers: it then completes once the page reloads. */
const deleteDb = (idb: Pick<IDBFactory, 'deleteDatabase'>, name: string, ms: number) =>
  settleWithin(
    () =>
      new Promise<void>((resolve) => {
        const req = idb.deleteDatabase(name);
        const done = () => resolve();
        req.onsuccess = done;
        req.onerror = done;
        // Still open somewhere: the delete completes once it closes; don't hang the UI.
        req.onblocked = () => setTimeout(done, Math.min(1500, ms));
      }),
    ms,
  );

/** The background in this page closes the wallet and keeps it closed (background.ts CLOSE_FOR_RELOAD_ACTION). */
const closeInPageWallet = (chrome: any) => () =>
  new Promise<void>((resolve) => {
    const r = chrome?.runtime?.sendMessage?.({ action: CLOSE_FOR_RELOAD_ACTION }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
    if (r && typeof r.then === 'function') r.then(resolve, resolve);
  });

export const wipeLocalWallet = async ({
  chrome,
  native,
  idb = indexedDB,
  session = sessionStorage,
  local = globalThis.localStorage,
  closePairings = async () => (await import('../pair/sessions')).closeAllPairings(),
  closeWallet = IS_EXTENSION ? undefined : closeInPageWallet(chrome),
  wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  restore = true,
  everySecureItem = !restore,
  caps: capsIn,
}: Deps): Promise<void> => {
  const caps = { ...WIPE_CAPS, ...capsIn };
  const step = (run: () => unknown) => settleWithin(run, caps.stepMs);

  // Biometrics first, so the old passKey can't come back even if a later step fails.
  await step(() => native.biometricRemove({ key: '' }));
  const listed = await within(() => native.secureKeys(), caps.stepMs, 'Listing secure items').catch(() => ({
    keys: [] as string[],
  }));
  for (const key of listed.keys.filter((k) => k.startsWith('bio:'))) await step(() => native.secureRemove({ key }));

  // The wallet's stores close before anything is deleted under them (see closeWallet). Capped: a close that hangs
  // must not hold the wipe; its databases are then deleted when the reload drops the connections.
  if (closeWallet) await settleWithin(closeWallet, caps.closeMs);

  // Paired sites: close the sockets now, so nothing keeps relaying until the reload.
  await step(closePairings);
  try {
    local?.clear();
  } catch {
    /* storage unavailable */
  }

  // Upstream sign-out (Settings.tsx): clear local storage, tell the background. The keys live here: it must finish.
  await within(() => chrome.storage.local.clear(), caps.stepMs, 'Clearing wallet storage').catch((e: unknown) => {
    throw new WipeError(`Could not remove the wallet from this phone (${e instanceof Error ? e.message : String(e)})`);
  });
  await step(() => chrome.storage.session?.clear?.());
  try {
    session.removeItem?.(SESSION_MIRROR);
  } catch {
    /* no sessionStorage */
  }
  chrome.runtime.sendMessage({ action: YoursEventName.SIGNED_OUT }, () => void chrome.runtime.lastError);
  await wait(300);

  // The background deletes IndexedDB too, but a reload stops its worker; do it here
  // as well and wait (capped). Same filter as background.ts (block header DBs are shared data).
  const dbs = await within(async () => (await idb.databases?.()) ?? [], caps.stepMs, 'Listing databases').catch(
    () => [] as IDBDatabaseInfo[],
  );
  for (const db of dbs) {
    if (!db.name || db.name.startsWith('block')) continue;
    await deleteDb(idb, db.name, caps.dbMs);
  }

  // Last, and checked: no wallet key is left in secure storage, even one written back after the clear (a late save).
  await sweepSecure(native, everySecureItem, caps.stepMs);

  if (!restore) return;
  try {
    session.setItem(RESTORE_FLAG, '1');
  } catch {
    /* falls back to the Start screen, which also offers Restore */
  }
};

/** Removes the wallet's secure items (or all of them), then lists again: any wallet key still there is a WipeError. */
const sweepSecure = async (native: Deps['native'], everyItem: boolean, ms: number) => {
  const mine = (k: string) => everyItem || k.startsWith(LOCAL_PREFIX) || k.startsWith('bio:');
  const list = () => within(() => native.secureKeys(), ms, 'Listing secure items');
  let left: string[] = [];
  try {
    for (const key of (await list()).keys.filter(mine)) {
      await within(() => native.secureRemove({ key }), ms, 'Removing a secure item').catch(() => undefined);
    }
    left = (await list()).keys.filter((k) => k.startsWith(LOCAL_PREFIX));
  } catch (e) {
    throw new WipeError(`Could not remove the wallet from this phone (${e instanceof Error ? e.message : String(e)})`);
  }
  if (left.length) throw new WipeError('Could not remove the wallet keys from this phone.');
};

/** MemoryRouter's first entry: the restore screen once, right after a wipe. */
export const initialRoute = (): string => {
  try {
    if (sessionStorage.getItem(RESTORE_FLAG)) {
      sessionStorage.removeItem(RESTORE_FLAG);
      return RESTORE_ROUTE;
    }
  } catch {
    /* no sessionStorage */
  }
  // The extension's popped-out Calls window opens on /m/calls (calls/popout.ts).
  return startRoute();
};
