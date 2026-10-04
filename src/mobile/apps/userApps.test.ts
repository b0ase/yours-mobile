import { describe, expect, test } from 'bun:test';
import { appNameFromUrl, normalizeAppUrl } from './userApps';

describe('Add app', () => {
  test('normalizeAppUrl: bare domains become https, junk is refused', () => {
    expect(normalizeAppUrl('zanaadu.com')).toBe('https://zanaadu.com/');
    expect(normalizeAppUrl('http://budz.lol/app')).toBe('https://budz.lol/app');
    expect(normalizeAppUrl('  ')).toBeNull();
    expect(normalizeAppUrl('localhost')).toBeNull();
  });
  test('appNameFromUrl: capitalised first label', () => {
    expect(appNameFromUrl('https://www.tokenblaster.lol/blast')).toBe('Tokenblaster');
  });
});
