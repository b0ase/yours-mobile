import { describe, expect, it } from 'bun:test';
import { masterBackupFileName } from './masterExporter';

describe('masterBackupFileName', () => {
  it('names the zip for the account, never a key', () => {
    const d = new Date(2026, 9, 11, 12);
    expect(masterBackupFileName('vexvoid', d)).toBe('bwalletx-backup-vexvoid-2026-10-11.zip');
    expect(masterBackupFileName('$VexVoid', d)).toBe('bwalletx-backup-vexvoid-2026-10-11.zip');
    expect(masterBackupFileName('Account 1', d)).toBe('bwalletx-backup-account-1-2026-10-11.zip');
    expect(masterBackupFileName('', d)).toBe('bwalletx-backup-account-2026-10-11.zip');
  });
});
