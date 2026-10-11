import { describe, expect, it } from 'bun:test';
import { masterBackupFileName } from './masterExporter';

describe('masterBackupFileName', () => {
  const d = new Date('2026-10-11T12:00:00Z');
  it('names the file after the account', () => {
    expect(masterBackupFileName('vexvoid', d)).toBe('vexvoid_bwalletx_backup_2026-10-11.zip');
    expect(masterBackupFileName('$VexVoid', d)).toBe('vexvoid_bwalletx_backup_2026-10-11.zip');
    expect(masterBackupFileName('Account 1', d)).toBe('account_1_bwalletx_backup_2026-10-11.zip');
  });
  it('falls back to a plain name', () => {
    expect(masterBackupFileName('', d)).toBe('bwalletx_backup_2026-10-11.zip');
  });
});
