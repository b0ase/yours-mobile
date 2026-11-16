import { describe, expect, test } from 'bun:test';
import { nativeAuth } from './siteGateNative';

describe('nativeAuth off a phone', () => {
  test('the web wallet and Desktop answer unavailable (the caller then asks for the password), never ok', async () => {
    expect(await nativeAuth('Seal', 'bChatX', () => false)).toEqual({ status: 'unavailable' });
  });
});
