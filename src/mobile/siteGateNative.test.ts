import { describe, expect, mock, test } from 'bun:test';

let prompt: () => Promise<unknown> = async () => ({ ok: true, method: 'biometric' });
// bun keeps a module mock for the rest of the process, so mock every export native.ts has (YoursNative, isNative):
// a later file importing isNative from it otherwise fails to load ("Export named 'isNative' not found").
mock.module('./native', () => ({ YoursNative: { deviceOwnerAuth: () => prompt() }, isNative: false }));
const { nativeAuth } = await import('./siteGateNative');

describe('nativeAuth', () => {
  test('off a phone (web wallet, Desktop): unavailable, so the caller asks for the password; never ok', async () => {
    expect(await nativeAuth('Seal', 'bChatX', () => false)).toEqual({ status: 'unavailable' });
  });

  test('on a phone, a prompt that throws (a broken shell) is unavailable, never ok', async () => {
    prompt = async () => {
      throw new Error('"YoursNative.deviceOwnerAuth()" is not implemented on web');
    };
    expect(await nativeAuth('Seal', 'bChatX', () => true)).toEqual({ status: 'unavailable' });
  });

  test('on a phone, a cancelled prompt refuses', async () => {
    prompt = async () => ({ ok: false, available: true });
    expect(await nativeAuth('Seal', 'bChatX', () => true)).toEqual({ status: 'cancelled' });
  });

  test('on a phone, Face ID passes as biometric', async () => {
    prompt = async () => ({ ok: true, method: 'biometric' });
    expect(await nativeAuth('Seal', 'bChatX', () => true)).toEqual({ status: 'ok', method: 'biometric' });
  });
});
