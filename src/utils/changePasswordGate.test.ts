import { describe, expect, test } from 'bun:test';
import { proveCurrentOwner, type ChangePasswordGateDeps } from './changePasswordGate';

const PHRASE = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

const deps = (over: Partial<ChangePasswordGateDeps> = {}): ChangePasswordGateDeps => ({
  verifyPassword: async (p: string) => p === 'right-password',
  readMnemonic: async () => PHRASE,
  ...over,
});

describe('proveCurrentOwner', () => {
  test('refuses with no proof', async () => {
    await expect(proveCurrentOwner(deps(), undefined)).rejects.toThrow(/current password/);
  });

  describe('(a) current password', () => {
    test('accepts the right one', async () => {
      await expect(proveCurrentOwner(deps(), { currentPassword: 'right-password' })).resolves.toBeUndefined();
    });
    test('refuses wrong, empty or a throwing verifier', async () => {
      await expect(proveCurrentOwner(deps(), { currentPassword: 'nope' })).rejects.toThrow(/wrong/);
      await expect(proveCurrentOwner(deps(), { currentPassword: '' })).rejects.toThrow(/wrong/);
      const boom = deps({ verifyPassword: () => Promise.reject(new Error('x')) });
      await expect(proveCurrentOwner(boom, { currentPassword: 'a' })).rejects.toThrow(/wrong/);
    });
  });

  describe('(b) device owner (Face ID / fingerprint / passcode)', () => {
    test('accepts a passing prompt', async () => {
      await expect(
        proveCurrentOwner(deps({ deviceOwnerAuth: async () => true }), { deviceOwner: true }),
      ).resolves.toBeUndefined();
    });
    test('refuses a cancelled or failing prompt', async () => {
      await expect(
        proveCurrentOwner(deps({ deviceOwnerAuth: async () => false }), { deviceOwner: true }),
      ).rejects.toThrow(/confirm/);
      await expect(
        proveCurrentOwner(deps({ deviceOwnerAuth: () => Promise.reject(new Error('x')) }), { deviceOwner: true }),
      ).rejects.toThrow(/confirm/);
    });
    test('refuses on web/extension where there is no device auth', async () => {
      await expect(proveCurrentOwner(deps(), { deviceOwner: true })).rejects.toThrow(/can't confirm/);
    });
  });

  describe('(c) 12 words', () => {
    test('accepts the phrase, ignoring case and spacing', async () => {
      await expect(
        proveCurrentOwner(deps(), { mnemonic: `  ${PHRASE.toUpperCase().replace(/ /g, '\n  ')} ` }),
      ).resolves.toBeUndefined();
    });
    test('refuses a different or partial phrase', async () => {
      await expect(proveCurrentOwner(deps(), { mnemonic: PHRASE.replace('abandon', 'zoo') })).rejects.toThrow(/match/);
      await expect(proveCurrentOwner(deps(), { mnemonic: 'abandon ability' })).rejects.toThrow(/match/);
      await expect(proveCurrentOwner(deps(), { mnemonic: '' })).rejects.toThrow(/match/);
    });
    test('refuses for a private-key account with no phrase', async () => {
      const noPhrase = deps({ readMnemonic: async () => undefined });
      await expect(proveCurrentOwner(noPhrase, { mnemonic: '' })).rejects.toThrow(/match/);
    });
  });
});
