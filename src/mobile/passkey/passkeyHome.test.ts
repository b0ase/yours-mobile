import { describe, expect, test } from 'bun:test';
import { passkeyHome, passkeyHomeLine } from './passkeyHome';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';

describe('where a new passkey is kept', () => {
  test('Apple devices and Safari', () => {
    expect(passkeyHome(IPHONE)).toBe('apple');
    expect(passkeyHome(MAC_SAFARI)).toBe('apple');
  });
  test('Android and Chrome', () => {
    expect(passkeyHome(ANDROID)).toBe('google');
    expect(passkeyHome(MAC_CHROME)).toBe('google');
  });
  test('anything else stays generic', () => {
    expect(passkeyHome(FIREFOX)).toBe('either');
    expect(passkeyHomeLine('either')).toContain('Apple or Google');
  });
  test('Chrome wording is soft (it can also use iCloud on a Mac)', () => {
    expect(passkeyHomeLine('google').startsWith('Usually')).toBe(true);
  });
});
