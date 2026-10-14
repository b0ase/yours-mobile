import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { isExtensionSender, isReservedHost, reservedOriginatorRefusal } from './adminOriginator';

const EXT = 'abcdefghijklmnopabcdefghijklmnop';

describe('isExtensionSender (H1)', () => {
  test('our own popup page is the extension', () => {
    expect(
      isExtensionSender(
        { id: EXT, origin: `chrome-extension://${EXT}`, url: `chrome-extension://${EXT}/index.html` },
        EXT,
      ),
    ).toBe(true);
  });
  test('a web page at http://<extid>/ is not', () => {
    expect(isExtensionSender({ id: EXT, origin: `http://${EXT}`, url: `http://${EXT}/` }, EXT)).toBe(false);
  });
  test('another extension is not', () => {
    expect(isExtensionSender({ id: 'other', origin: 'chrome-extension://other' }, EXT)).toBe(false);
  });
  test('origin prefix tricks are not', () => {
    expect(isExtensionSender({ id: EXT, origin: `chrome-extension://${EXT}x` }, EXT)).toBe(false);
    expect(isExtensionSender({ id: EXT, origin: `chrome-extension://${EXT}`, url: `https://evil.example/` }, EXT)).toBe(
      false,
    );
  });
  test('mobile dApp context (sender id is the app, origin is the site) is not', () => {
    expect(
      isExtensionSender(
        { id: 'yours-mobile', origin: 'http://yours-mobile', url: 'http://yours-mobile/' },
        'yours-mobile',
      ),
    ).toBe(false);
    expect(
      isExtensionSender(
        { id: 'yours-mobile', origin: 'chrome-extension://yours-mobile', url: 'chrome-extension://yours-mobile/popup' },
        'yours-mobile',
      ),
    ).toBe(true);
  });
  test('missing sender or id is not', () => {
    expect(isExtensionSender(undefined, EXT)).toBe(false);
    expect(isExtensionSender({ origin: `chrome-extension://${EXT}` }, EXT)).toBe(false);
  });
});

describe('reservedOriginatorRefusal (H1)', () => {
  test('a web sender claiming the admin originator is refused', () => {
    expect(reservedOriginatorRefusal(false, EXT, EXT)).toBe('Reserved originator');
    expect(reservedOriginatorRefusal(false, EXT.toUpperCase(), EXT)).toBe('Reserved originator');
  });
  test('the extension itself may use it', () => {
    expect(reservedOriginatorRefusal(true, EXT, EXT)).toBeNull();
  });
  test('ordinary sites pass', () => {
    expect(reservedOriginatorRefusal(false, 'example.com', EXT)).toBeNull();
    expect(reservedOriginatorRefusal(false, undefined, EXT)).toBeNull();
  });
});

describe('isReservedHost (mobile in-app browser)', () => {
  test('http://yours-mobile cannot claim the app', () => {
    expect(isReservedHost('yours-mobile', 'yours-mobile')).toBe(true);
    expect(isReservedHost('YOURS-MOBILE.', 'yours-mobile')).toBe(true);
    expect(isReservedHost('yours-mobile:8080', 'yours-mobile')).toBe(true);
    expect(isReservedHost('example.com', 'yours-mobile')).toBe(false);
  });
});

describe('wiring', () => {
  const bg = readFileSync(new URL('../background.ts', import.meta.url), 'utf8');
  const dapp = readFileSync(new URL('../mobile/dappBrowser.ts', import.meta.url), 'utf8');
  test('router derives isFromExtension from the sender, and refuses the reserved originator', () => {
    expect(bg).toContain('const isFromExtension = isExtensionSender(sender, chrome.runtime.id);');
    expect(bg).toContain('reservedOriginatorRefusal(isFromExtension, message?.originator, ADMIN_ORIGINATOR)');
    expect(bg).not.toContain('sender.origin?.startsWith(`chrome-extension://${chrome.runtime.id}`)');
  });
  test('handleSiteCall refuses the mobile admin host', () => {
    expect(dapp).toContain('isReservedHost(o.host, MOBILE_EXTENSION_ID)');
  });
});
