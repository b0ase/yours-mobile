import { describe, expect, test } from 'bun:test';
import { accountKey, addressAt, GAP, normalizePath, phraseProblem, scanAccount } from './hd';

// BIP39 test vector phrase (public, holds nothing).
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('HD sweep', () => {
  test('phrase checks', () => {
    expect(phraseProblem(PHRASE)).toBeNull();
    expect(phraseProblem('abandon abandon')).toContain('12 or 24');
    expect(phraseProblem(PHRASE.replace('about', 'abandon'))).toContain('mistyped');
  });

  test('paths', () => {
    expect(normalizePath("m/44'/145'/0'")).toBe("m/44'/145'/0'");
    expect(normalizePath('44h/236h/0h')).toBe("m/44'/236'/0'");
    expect(normalizePath('m/44/x')).toBeNull();
  });

  test('BIP44 vector: first Bitcoin receive address', () => {
    const acct = accountKey(PHRASE, '', "m/44'/0'/0'");
    expect(addressAt(acct, "m/44'/0'/0'", 0, 0).address).toBe('1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA');
  });

  test('stops after the gap limit and finds used addresses on both chains', async () => {
    const acct = accountKey(PHRASE, '', "m/44'/145'/0'");
    const used = new Set([
      addressAt(acct, "m/44'/145'/0'", 0, 0).address,
      addressAt(acct, "m/44'/145'/0'", 0, 5).address,
      addressAt(acct, "m/44'/145'/0'", 1, 2).address,
    ]);
    let calls = 0;
    const found = await scanAccount(acct, "m/44'/145'/0'", async (a) => (calls++, used.has(a)));
    expect(found.map((f) => f.path)).toEqual(["m/44'/145'/0'/0/0", "m/44'/145'/0'/0/5", "m/44'/145'/0'/1/2"]);
    expect(calls).toBe(6 + GAP + 3 + GAP);
  });
});
