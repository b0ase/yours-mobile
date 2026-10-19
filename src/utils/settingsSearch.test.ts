import { describe, expect, test } from 'bun:test';
import {
  BASE_SETTINGS,
  registerSettingsEntries,
  requestSettingsScreen,
  searchSettings,
  takeSettingsScreen,
} from './settingsSearch';

const top = (q: string) => searchSettings(q)[0]?.id;

describe('searchSettings', () => {
  test.each(['seed', 'words', 'recovery', 'phrase', 'mnemonic', 'Seed Phrase', '12 words', 'show my'])(
    '%s finds Show my 12 words first',
    (q) => expect(top(q)).toBe('show-words'),
  );
  test('backup and export find Wallet Backup', () => {
    expect(top('backup')).toBe('backup');
    expect(searchSettings('export').map((e) => e.id)).toContain('backup');
  });
  test('label prefix and case', () => {
    expect(top('TROUBLE')).toBe('troubleshooting');
    expect(top('usb')).toBe('usb');
    expect(top('fee')).toBe('fee');
  });
  test('every word must match', () => {
    expect(searchSettings('seed zebra')).toEqual([]);
    expect(searchSettings('   ')).toEqual([]);
  });
  test('registered rows (phone settings) are searchable: password finds Change password', () => {
    registerSettingsEntries([
      {
        id: 'feed-password',
        label: 'Change password',
        description: 'x',
        keywords: ['password', 'passphrase'],
        target: { kind: 'screen', screen: 'password' },
      },
    ]);
    expect(top('password')).toBe('feed-password');
    expect(top('passphrase')).toBe('feed-password');
    expect(BASE_SETTINGS.some((e) => e.id === 'feed-password')).toBe(false);
  });
  test('a screen request waits until taken, once', () => {
    requestSettingsScreen('password');
    expect(takeSettingsScreen()).toBe('password');
    expect(takeSettingsScreen()).toBeUndefined();
  });
});
