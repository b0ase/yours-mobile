/**
 * Recover change from my 12 words runs on this device's store only: claiming while the remote store is active can make
 * a coin the remote holds as spent spendable again (review 07b, L1). Release click-through, 4 Nov 2026: on a freshly
 * restored account, or while an open was moving the account, a Recover tapped in that window was refused ("main copy
 * is still the remote backup") or failed with the toolbox's raw "Active "WalletStorageProvider" does not support
 * "StorageProvider" interface." (withRepairStore checks the active store, then waits for the storage locks; the store
 * could change in between).
 *
 * Now the run waits for the move instead: "Waiting for your backup…" while the account moves to this device (the same
 * move as "Retry moving this account to this device", joining one already running), then runs. If the run still
 * trips on the store changing under it, it waits for the move and tries once more. If the backup never answers, it
 * says so in plain words; the toolbox's message is never shown. Pure apart from the injected deps.
 */

export const WAITING_FOR_BACKUP = 'Waiting for your backup…';

export const STILL_ON_BACKUP_MESSAGE =
  "This account's records are still on the online backup (wallet.1sat.app), which hasn't answered yet. Recover change runs as soon as they have moved to this device. Nothing was changed. Tap Recover change again in a minute.";

/** The store changed under the run, or the run found the remote active: wait for the move, never show these words. */
const STORE_NOT_READY = /does not support "?StorageProvider"? interface|main copy is still the remote backup/i;

export const storeNotReady = (message: string | undefined | null): boolean =>
  !!message && STORE_NOT_READY.test(message);

export type RecoverOnDeviceDeps<R extends { error?: string }> = {
  /** This device's store is the active one right now. */
  isLocal: () => boolean;
  /** Move this account to this device now (joining a move already running); true once the device store is active. */
  moveNow: () => Promise<boolean>;
  run: () => Promise<R>;
  progress?: (step: string) => void;
  log?: (...a: unknown[]) => void;
};

export type RecoverOnDeviceResult<R> = { ran: true; report: R } | { ran: false; message: string };

export async function recoverOnDevice<R extends { error?: string }>(
  d: RecoverOnDeviceDeps<R>,
): Promise<RecoverOnDeviceResult<R>> {
  const log = d.log ?? (() => undefined);
  const onDevice = async (): Promise<boolean> => {
    if (d.isLocal()) return true;
    d.progress?.(WAITING_FOR_BACKUP);
    const moved = await d.moveNow().catch((e: unknown) => {
      log('[recoverOnDevice] move to this device failed:', e);
      return false;
    });
    return moved && d.isLocal();
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(await onDevice())) return { ran: false, message: STILL_ON_BACKUP_MESSAGE };
    let report: R;
    try {
      report = await d.run();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!storeNotReady(message)) throw e;
      log('[recoverOnDevice] the store changed under the run; waiting for the move:', message);
      continue;
    }
    if (!storeNotReady(report.error)) return { ran: true, report };
    log('[recoverOnDevice] the run found the remote store active; waiting for the move:', report.error);
  }
  return { ran: false, message: STILL_ON_BACKUP_MESSAGE };
}
