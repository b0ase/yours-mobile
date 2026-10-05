/**
 * The encrypted backup file: the same master backup as Settings › Backup (src/utils/masterExporter.ts,
 * background MASTER_BACKUP), whose keys stay encrypted with a key derived from the wallet password.
 * Unlike masterExporter it returns the file instead of forcing a download, so iOS can offer the
 * share sheet (Save to Files, Mail, AirDrop). Nothing is sent anywhere by this module.
 */
import type { ChromeStorageService } from '../../services/ChromeStorage.service';
import { derivePasswordKey } from '../../services/passKey';
import { backupFileName } from './backupState';

export class WrongPasswordError extends Error {
  constructor() {
    super('Incorrect password');
    this.name = 'WrongPasswordError';
  }
}

export const createBackupFile = async (cs: ChromeStorageService, password: string): Promise<File> => {
  if (!password || !(await cs.verifyPassword(password))) throw new WrongPasswordError();
  const { salt } = cs.getCurrentAccountObject();
  // Derived here: runtime messages fan out to every page, so the password itself never leaves this one.
  const passwordKey = salt ? derivePasswordKey(password, salt) : undefined;
  const res = (await chrome.runtime.sendMessage({ action: 'MASTER_BACKUP', passwordKey })) as
    | { success?: boolean; data?: string; error?: string }
    | undefined;
  if (!res?.success || !res.data) throw new Error(res?.error || 'Backup failed');
  const bin = atob(res.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], backupFileName(), { type: 'application/zip' });
};

export type SaveRoute = 'share' | 'download' | 'none';

/** Share sheet with a file where the browser supports it, else a normal download (not in native WebViews). */
export const saveRoute = (file: File, native: boolean): SaveRoute => {
  try {
    if (typeof navigator !== 'undefined' && navigator.canShare?.({ files: [file] })) return 'share';
  } catch {
    /* canShare throws on some browsers */
  }
  return native ? 'none' : 'download';
};

/** Must run inside a tap (iOS needs a user gesture for navigator.share). Resolves false if cancelled. */
export const saveBackupFile = async (file: File, route: SaveRoute): Promise<boolean> => {
  if (route === 'share') {
    try {
      await navigator.share({ files: [file], title: 'bWallet backup' });
      return true;
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return false;
      throw e;
    }
  }
  if (route === 'download') {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  }
  return false;
};
