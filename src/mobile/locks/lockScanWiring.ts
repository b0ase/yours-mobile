/**
 * Page-side wiring for "Find my locks" (lockFinder.ts):
 * - the device store a scan files into (background LOCK_SCAN_STORE, services/lockScanStore.ts), so the "scanned" flag
 *   belongs to that store and a recreated store is scanned again;
 * - the repair for a lock whose transaction this device holds as failed: the same one as Settings › Troubleshooting ›
 *   Recover a payment by transaction ID (STORAGE_RECOVER_TXID, services/recoverByTxid.ts), which only ever adds what
 *   it proves is this wallet's.
 */
import { sendMessageAsync } from '../../utils/chromeHelpers';
import { withTimeout } from '../withTimeout';
import type { FindBsvLocksOptions } from './lockFinder';

/** The fingerprint of the store the wallet writes to now; undefined when the background can't say. */
export async function lockScanStore(): Promise<string | undefined> {
  try {
    const r = await withTimeout(
      sendMessageAsync<{ success?: boolean; data?: { store?: unknown } }>({ action: 'LOCK_SCAN_STORE' }),
      15_000,
      'The store check',
    );
    return r?.success && typeof r.data?.store === 'string' ? r.data.store : undefined;
  } catch {
    return undefined;
  }
}

/** Recover a payment by transaction ID; true when the wallet now holds it as settled. */
export async function repairLockTxid(txid: string): Promise<boolean> {
  try {
    const r = await sendMessageAsync<{ success?: boolean }>({ action: 'STORAGE_RECOVER_TXID', txid });
    return !!r?.success;
  } catch {
    return false;
  }
}

/** The options every app-side scan passes: this store, and the payment repair. */
export async function lockScanOptions(): Promise<Pick<FindBsvLocksOptions, 'store' | 'repairTxid'>> {
  return { store: await lockScanStore(), repairTxid: repairLockTxid };
}
