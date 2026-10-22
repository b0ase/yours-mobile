import { describe, expect, test } from 'bun:test';
import { createPasskeyWalletForExtension, type CreateDeps } from './extHandoffCreate';
import { openSeed, sealSeed, type SeedBackupBlob } from './seedBackup';

const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const fake = (over: Partial<CreateDeps> = {}) => {
  const prf = new Uint8Array(32).fill(7);
  const calls = { saved: [] as SeedBackupBlob[], uploads: [] as [SeedBackupBlob, string][] };
  const d: CreateDeps = {
    rpId: () => 'bwalletx.com',
    createPasskey: async () => ({ credentialId: 'cred-1', prf }),
    newKeys: () => ({ mnemonic: WORDS, identityWif: 'L-identity' }),
    seal: sealSeed,
    saveLocal: (b) => void calls.saved.push(b),
    upload: async (b, wif) => {
      calls.uploads.push([b, wif]);
      return true;
    },
    ...over,
  };
  return { d, prf, calls };
};

describe('create a passkey wallet for the extension', () => {
  test('returns the new words, sealed with the passkey locally and online', async () => {
    const { d, calls } = fake();
    const r = await createPasskeyWalletForExtension(d);
    expect(r).toEqual({ words: WORDS, savedOnline: true });
    expect(calls.saved).toHaveLength(1);
    expect(calls.saved[0].credentialId).toBe('cred-1');
    expect(calls.saved[0].rpId).toBe('bwalletx.com');
    expect(calls.uploads[0][1]).toBe('L-identity');
    // The sealed copy opens with the same passkey output and holds exactly these words.
    expect(await openSeed(calls.saved[0], new Uint8Array(32).fill(7))).toBe(WORDS);
  });
  test('the passkey secret is wiped afterwards', async () => {
    const { d, prf } = fake();
    await createPasskeyWalletForExtension(d);
    expect(prf.every((b) => b === 0)).toBe(true);
  });
  test('an online save that fails is reported, not fatal', async () => {
    const { d } = fake({ upload: async () => Promise.reject(new Error('503')) });
    expect((await createPasskeyWalletForExtension(d)).savedOnline).toBe(false);
  });
  test('a cancelled passkey prompt creates nothing', async () => {
    const { d, calls } = fake({ createPasskey: async () => Promise.reject(new Error('NotAllowedError')) });
    await expect(createPasskeyWalletForExtension(d)).rejects.toThrow('NotAllowedError');
    expect(calls.saved).toHaveLength(0);
  });
});
