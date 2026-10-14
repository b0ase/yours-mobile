import { describe, expect, test } from 'bun:test';
import { canShareScreen, isShareCancelled, shareLayout } from './screenShare';

const gdm = () => undefined;

describe('canShareScreen', () => {
  test('desktop browser / extension with getDisplayMedia', () => {
    expect(canShareScreen({ native: false, mediaDevices: { getDisplayMedia: gdm } })).toBe(true);
  });
  test('native apps never show it, even if the WebView exposes it', () => {
    expect(canShareScreen({ native: true, mediaDevices: { getDisplayMedia: gdm } })).toBe(false);
  });
  test('phone browsers without getDisplayMedia', () => {
    expect(canShareScreen({ native: false, mediaDevices: {} })).toBe(false);
    expect(canShareScreen({ native: false, mediaDevices: null })).toBe(false);
    expect(canShareScreen({ native: false })).toBe(false);
  });
});

describe('shareLayout', () => {
  test('nobody sharing: normal layout', () => {
    expect(shareLayout({ remoteShare: false, remoteCamera: true, selfCamera: true })).toBeNull();
  });
  test('peer shares with camera on: screen large, their face small', () => {
    expect(shareLayout({ remoteShare: true, remoteCamera: true, selfCamera: true })).toEqual({
      screen: 'full',
      remote: 'corner',
      self: 'none',
    });
  });
  test('peer shares camera off: our camera in the corner if on', () => {
    expect(shareLayout({ remoteShare: true, remoteCamera: false, selfCamera: true })).toEqual({
      screen: 'full',
      remote: 'none',
      self: 'corner',
    });
    expect(shareLayout({ remoteShare: true, remoteCamera: false, selfCamera: false })).toEqual({
      screen: 'full',
      remote: 'none',
      self: 'none',
    });
  });
});

describe('isShareCancelled', () => {
  test('picker closed', () => {
    const e = new Error('x');
    e.name = 'NotAllowedError';
    expect(isShareCancelled(e)).toBe(true);
    expect(isShareCancelled(new Error('boom'))).toBe(false);
  });
});
