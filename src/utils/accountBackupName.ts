import type { ChromeStorageService } from '../services/ChromeStorage.service';
import { accountNamesFor } from '../mobile/names/accountNames';
import { backupFileName } from './backupFileName';

/** The current account's backup filename: its $handle, else its account name (never a key). */
export const currentAccountBackupName = (cs: ChromeStorageService, ext: string, now = new Date()): string => {
  const { account } = cs.getCurrentAccountObject();
  const names = accountNamesFor(account?.addresses?.identityAddress, account?.name ?? '');
  return backupFileName(names.payable || names.displayName, ext, now);
};
