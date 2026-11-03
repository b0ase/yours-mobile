import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { isBchatPageUrl } from './dappBrowser';

// Owner's iPhone, 3 Nov 2026 05:36Z: a Chat-tab card opened chat.bwalletx.com in the native dApp browser, where the seal
// stalled on "Waiting for request…". Every bChatX page goes to the bApp frame on the phone.
test('bChatX page URLs are recognised (both origins and the apex), nothing else', () => {
  for (const u of ['https://www.bchatx.com/room/BCORPBOARD?doc=1', 'https://chat.bwalletx.com/r/X', 'https://bchatx.com/'])
    expect(isBchatPageUrl(u)).toBe(true);
  for (const u of ['https://evil.com/?u=www.bchatx.com', 'https://www.bchatx.com.evil.com/', 'not a url', 'https://web.bwalletx.com/bapp/bchatx'])
    expect(isBchatPageUrl(u)).toBe(false);
});

test('openDappBrowser hands bChatX pages to the frame; the frame falls back with noFrame (no loop)', () => {
  const src = readFileSync(new URL('./dappBrowser.ts', import.meta.url), 'utf8');
  expect(src).toMatch(/isNative && !opts\.noFrame && isBchatPageUrl\(rawUrl\)[\s\S]{0,120}openBapp\('bChatX', rawUrl\)/);
  const frame = readFileSync(new URL('./bappFrame/bappFrame.ts', import.meta.url), 'utf8');
  expect(frame.match(/openDappBrowser\(url\)/g)).toBeNull();
  expect(frame).toMatch(/if \(ok\) probed\.set\(origin, ok\)/);
});
