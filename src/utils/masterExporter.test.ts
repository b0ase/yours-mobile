import { describe, expect, it } from 'bun:test';
import { masterBackupFileName } from './masterExporter';

describe('masterBackupFileName', () => {
  const d = new Date('2026-10-11T12:00:00Z');
  const key = '02CBE7aa11';
  it('names the file after the handle and identity key', () => {
    expect(masterBackupFileName('vexvoid', key, d)).toBe('vexvoid_02cbe7_bwalletx_backup_2026-10-11.zip');
    expect(masterBackupFileName('$VexVoid', key, d)).toBe('vexvoid_02cbe7_bwalletx_backup_2026-10-11.zip');
  });
  it('falls back when parts are missing', () => {
    expect(masterBackupFileName('', key, d)).toBe('02cbe7_bwalletx_backup_2026-10-11.zip');
    expect(masterBackupFileName('Account 1', '', d)).toBe('account_1_bwalletx_backup_2026-10-11.zip');
    expect(masterBackupFileName('', '', d)).toBe('bwalletx_backup_2026-10-11.zip');
  });
});
