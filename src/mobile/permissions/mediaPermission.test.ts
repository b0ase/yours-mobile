import { describe, expect, test } from 'bun:test';
import { canOpenSettings, deniedText, isPermissionDenied, toMediaPlatform } from './mediaPermission';

describe('mediaPermission', () => {
  test('iOS points at iPhone Settings › Apps › bWallet', () => {
    expect(deniedText('mic', 'ios')).toBe(
      'Microphone is off for bWallet. Turn it on in iPhone Settings › Apps › bWallet › Microphone.',
    );
    expect(deniedText('camera', 'ios')).toContain('› bWallet › Camera.');
  });
  test('Android points at app Permissions', () => {
    expect(deniedText('mic', 'android')).toBe(
      'Microphone is off for bWallet. Turn it on in Android Settings › Apps › bWallet › Permissions.',
    );
  });
  test('web points at the browser site settings', () => {
    expect(deniedText('mic', 'web')).toMatch(/site settings.*lock icon/);
    expect(deniedText('mic', 'web')).not.toMatch(/iPhone|Android/);
  });
  test('platform mapping and settings button', () => {
    expect(toMediaPlatform('ios')).toBe('ios');
    expect(toMediaPlatform('android')).toBe('android');
    expect(toMediaPlatform('electron')).toBe('web');
    expect(canOpenSettings('ios')).toBe(true);
    expect(canOpenSettings('android')).toBe(true);
    expect(canOpenSettings('web')).toBe(false);
  });
  test('detects permission refusals only', () => {
    expect(isPermissionDenied(new DOMException('x', 'NotAllowedError'))).toBe(true);
    expect(isPermissionDenied({ name: 'PermissionDeniedError' })).toBe(true);
    expect(isPermissionDenied(new DOMException('x', 'NotFoundError'))).toBe(false);
    expect(isPermissionDenied(null)).toBe(false);
  });
});
