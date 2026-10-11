import { ChromeStorageService } from '../services/ChromeStorage.service';
import { accountNamesFor } from '../mobile/names/accountNames';

/**
 * `vexvoid_02cbe7_bwalletx_backup_2026-10-11.zip`: the account's $handle (else its name) plus the start of
 * its identity key, which is the account itself (handles change). The owner never renames the file to
 * know whose backup it is (owner, 11 Oct 2026).
 */
export const masterBackupFileName = (name: string, identityKey = '', now = new Date()): string => {
  const slug = name
    .replace(/^\$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const key = /^[0-9a-f]{6}/i.test(identityKey) ? identityKey.slice(0, 6).toLowerCase() : '';
  const prefix = [slug, key].filter(Boolean).join('_');
  return `${prefix ? `${prefix}_` : ''}bwalletx_backup_${now.toISOString().split('T')[0]}.zip`;
};

export type MasterBackupProgressEvent = {
  message: string;
  value?: number;
  endValue?: number;
  /** Name of the account currently being backed up. */
  accountName?: string;
  /** 0-based index of the account being backed up. */
  accountIndex?: number;
  /** Total number of accounts in the backup. */
  totalAccounts?: number;
  stage?: 'preparing' | 'exporting' | 'complete' | 'error';
};

type MasterBackupProgress = (event: MasterBackupProgressEvent) => void;

/**
 * Initiates master backup by sending a message to the background script.
 * Listens for MASTER_BACKUP_PROGRESS broadcasts to stream per-account
 * progress back to the caller in real time.
 */
export const streamDataToZip = async (
  chromeStorageService: ChromeStorageService,
  progress: MasterBackupProgress,
  /** Password-only key (PBKDF2 of the password). With USB unlock on, export needs it to re-encrypt. */
  passwordKey?: string,
) => {
  progress({ message: 'Starting backup...', stage: 'preparing' });

  // Listen for progress broadcasts from the background script
  const progressListener = (message: { action?: string; data?: MasterBackupProgressEvent }) => {
    if (message.action === 'MASTER_BACKUP_PROGRESS' && message.data) {
      const d = message.data;
      progress({
        message: d.message,
        accountName: d.accountName,
        accountIndex: d.accountIndex,
        totalAccounts: d.totalAccounts,
        stage: d.stage,
        value: d.accountIndex !== undefined ? d.accountIndex + 1 : undefined,
        endValue: d.totalAccounts,
      });
    }
  };

  chrome.runtime.onMessage.addListener(progressListener);

  try {
    const response = await chrome.runtime.sendMessage({ action: 'MASTER_BACKUP', passwordKey });

    chrome.runtime.onMessage.removeListener(progressListener);

    if (!response.success) {
      throw new Error(response.error || 'Backup failed');
    }

    // The background script returns a base64-encoded blob
    const binaryString = atob(response.data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: 'application/zip' });

    // Trigger download
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const { account } = chromeStorageService.getCurrentAccountObject();
    const names = accountNamesFor(account?.addresses?.identityAddress, account?.name ?? '');
    a.download = masterBackupFileName(names.payable || names.displayName, account?.pubKeys?.identityPubKey);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    progress({ message: 'Backup complete!', stage: 'complete' });
  } catch (error) {
    chrome.runtime.onMessage.removeListener(progressListener);
    const message = error instanceof Error ? error.message : 'Unknown error';
    progress({ message: `Backup failed: ${message}`, stage: 'error' });
    throw error;
  }
};
