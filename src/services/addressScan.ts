/**
 * Which deposit addresses the address sync scans, and when it must rescan history.
 *
 * Owner, 10 Oct 2026: the Chrome extension did not show 0.254 BSV paid to one of the wallet's own deposit
 * addresses (13WRxSg…, a fresh address handed out for a payment). Two gaps let that happen:
 *
 *  1. The sync only derived indexes 0..maxKeyIndex, and maxKeyIndex is stored PER DEVICE. A fresh address made
 *     on the phone, the web wallet or desktop (Receive › New address, a Swap payout) is past this device's
 *     maxKeyIndex, so this device never looked at it.
 *  2. @1sat/actions keeps ONE resume cursor (lastScore) for all addresses. When an address joins the scanned set
 *     after the cursor has passed the block its payment landed in, the sync resumes after that block and the
 *     payment is never seen, even once the address is included.
 *
 * Fix: always scan a gap of unused indexes past maxKeyIndex (like a BIP-44 gap limit), and whenever the scanned
 * window reaches indexes this device has never scanned, reset the cursor once so the whole history is read again
 * for every address. Already-processed transactions are skipped by the action's own store, so a rescan only
 * costs time.
 */

/** Unused indexes scanned past maxKeyIndex. Covers addresses handed out on other devices. */
export const DEPOSIT_GAP = 20;

export interface AddressScanPlan {
  /** Addresses to derive and scan, from index 0. */
  count: number;
  /** Highest index this plan scans (store it as the account's addressScanThrough after a successful sync). */
  through: number;
  /** True when the window includes indexes never scanned here: the sync cursor must be reset first. */
  resetCursor: boolean;
}

export const planAddressScan = (
  maxKeyIndex: number | undefined,
  scannedThrough: number | undefined,
): AddressScanPlan => {
  const max = Math.max(0, Math.floor(maxKeyIndex ?? 4));
  const through = max + DEPOSIT_GAP;
  return {
    count: through + 1,
    through,
    // Unknown (never recorded): this device last scanned an unknown, smaller window. Rescan once.
    resetCursor: scannedThrough === undefined || scannedThrough < through,
  };
};

/** The IndexedDB database @1sat/actions' ProcessedTxStoreIdb keeps per identity key, and its cursor record. */
export const syncStoreName = (identityKey: string) => `sync-processed-${identityKey}`;
const STATE_STORE = 'sync_state';
const CURSOR_KEY = 'lastScore';

/**
 * Forget the address sync's resume cursor so the next sync reads the full history again. Leaves the record of
 * processed transactions alone, so nothing is ingested twice. Resolves false when there is nothing to reset
 * (no IndexedDB, or the store does not exist yet: a first sync reads everything anyway).
 */
export const resetSyncCursor = async (
  identityKey: string,
  idb: IDBFactory | undefined = globalThis.indexedDB,
): Promise<boolean> => {
  if (!idb) return false;
  const db = await new Promise<IDBDatabase | null>((resolve) => {
    let created = false;
    const req = idb.open(syncStoreName(identityKey));
    req.onupgradeneeded = () => {
      // The store did not exist: abort so we don't create an empty one with the wrong schema.
      created = true;
      req.transaction?.abort();
    };
    req.onsuccess = () => resolve(created ? null : req.result);
    req.onerror = () => resolve(null);
  });
  if (!db) return false;
  try {
    if (!db.objectStoreNames.contains(STATE_STORE)) return false;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STATE_STORE, 'readwrite');
      tx.objectStore(STATE_STORE).delete(CURSOR_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } finally {
    db.close();
  }
};
