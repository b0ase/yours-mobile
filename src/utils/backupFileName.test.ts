import { describe, expect, it } from 'bun:test';
import { accountSlug, backupFileName } from './backupFileName';

describe('accountSlug', () => {
  it('makes a lowercase ASCII hyphen slug', () => {
    expect(accountSlug('Account 2')).toBe('account-2');
    expect(accountSlug('$VexVoid')).toBe('vexvoid');
    expect(accountSlug('  Café  Savings!! ')).toBe('cafe-savings');
    expect(accountSlug('a/b\\c:d*?"<>|')).toBe('a-b-c-d');
    expect(accountSlug('火星 wallet')).toBe('wallet');
  });
  it('caps at 40 characters without a trailing hyphen', () => {
    const s = accountSlug(`${'a'.repeat(39)} bcd`);
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s).toBe('a'.repeat(39));
    expect(accountSlug('x'.repeat(100))).toHaveLength(40);
  });
  it('falls back to account when nothing is left', () => {
    expect(accountSlug('')).toBe('account');
    expect(accountSlug(undefined)).toBe('account');
    expect(accountSlug('🔥🔥')).toBe('account');
  });
});

describe('backupFileName', () => {
  it('uses the agreed format', () => {
    const d = new Date(2026, 9, 18, 12);
    expect(backupFileName('Account 2', 'zip', d)).toBe('bwalletx-backup-account-2-2026-10-18.zip');
    expect(backupFileName('$b0asex', '.json', d)).toBe('bwalletx-backup-b0asex-2026-10-18.json');
    expect(backupFileName('', 'zip', d)).toBe('bwalletx-backup-account-2026-10-18.zip');
  });
});
