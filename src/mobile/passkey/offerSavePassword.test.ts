import { describe, expect, test } from 'bun:test';
import { offerSavePassword } from './passkeyUi';

class FakePC {
  constructor(public d: { id: string; password: string; name: string }) {}
}

describe('offerSavePassword', () => {
  test('stores the derived password under the passkey name', async () => {
    const stored: unknown[] = [];
    const ok = await offerSavePassword('bWalletX · 23 Oct 01:00', 'pk1.abc', { PasswordCredential: FakePC }, {
      store: async (c) => (stored.push(c), c),
    } as never);
    expect(ok).toBe(true);
    expect((stored[0] as FakePC).d).toEqual({
      id: 'bWalletX · 23 Oct 01:00',
      password: 'pk1.abc',
      name: 'bWalletX · 23 Oct 01:00',
    });
  });
  test('does nothing without PasswordCredential (Safari) or in the native app', async () => {
    const store = async () => {
      throw new Error('should not be called');
    };
    expect(await offerSavePassword('n', 'p', {}, { store } as never)).toBe(false);
    expect(
      await offerSavePassword('n', 'p', { PasswordCredential: FakePC, Capacitor: { isNativePlatform: () => true } }, {
        store,
      } as never),
    ).toBe(false);
  });
  test('a refused save is not an error', async () => {
    const ok = await offerSavePassword('n', 'p', { PasswordCredential: FakePC }, {
      store: async () => {
        throw new Error('NotAllowedError');
      },
    } as never);
    expect(ok).toBe(false);
  });
});
