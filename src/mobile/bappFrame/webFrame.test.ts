import { describe, expect, test } from 'bun:test';
import { WEB_FRAME_ORIGINS, frameModeFor } from './webFrame';
import { frameAllowlist } from './frameBridge';
import { BAPPS } from '../bapps';
import { STORE_BUILD } from '../storeBuild';

// Same rule as bappFrame.ts BAPP_FRAME_ALLOWLIST (that module needs Capacitor and the browser).
const BAPP_FRAME_ALLOWLIST = frameAllowlist(
  BAPPS.filter((a) => !a.noFrame && !(STORE_BUILD && a.privateOnly) && !a.url.startsWith('/')).map((a) => a.url),
);

const BCHATX = 'https://www.bchatx.com';

describe('bChatX in the wallet frame', () => {
  test('www.bchatx.com is a bApp tile and allowlisted exactly (not bare bchatx.com)', () => {
    expect(BAPPS.some((a) => a.url === BCHATX && a.webFrame)).toBe(true);
    expect(BAPP_FRAME_ALLOWLIST.has(BCHATX)).toBe(true);
    expect(WEB_FRAME_ORIGINS.has(BCHATX)).toBe(true);
    expect(BAPP_FRAME_ALLOWLIST.has('https://bchatx.com')).toBe(false);
    expect(WEB_FRAME_ORIGINS.has('https://bchatx.com')).toBe(false);
  });
  test('web/Desktop (not native, not extension) frames bChatX without a header probe', () => {
    expect(frameModeFor(BCHATX, { native: false, extension: false })).toBe('trusted');
  });
  test('web: other bApps still open in a tab; unknown origins never frame', () => {
    const other = [...BAPP_FRAME_ALLOWLIST].find((o) => !WEB_FRAME_ORIGINS.has(o));
    if (other) expect(frameModeFor(other, { native: false, extension: false })).toBe('tab');
    expect(frameModeFor(null, { native: false, extension: false })).toBe('tab');
    expect(frameModeFor(null, { native: true, extension: false })).toBe('tab');
  });
  test('native and extension keep the header probe', () => {
    expect(frameModeFor(BCHATX, { native: true, extension: false })).toBe('frame');
    expect(frameModeFor(BCHATX, { native: false, extension: true })).toBe('frame');
  });
});
