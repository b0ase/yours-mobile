import { describe, expect, test } from 'bun:test';
import { HD, Mnemonic } from '@bsv/sdk';
import {
  accountKey,
  accountKeyNonCompliant,
  addressAt,
  GAP,
  hardenedChild,
  normalizePath,
  parseRecovery,
  phraseProblem,
  scanAccount,
} from './hd';

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

  test('SimplyCash recovery strings', () => {
    expect(parseRecovery(`${PHRASE}:m/44'/145'/0':my:secret`)).toEqual({
      phrase: PHRASE,
      path: "m/44'/145'/0'",
      passphrase: 'my:secret',
    });
    expect(parseRecovery(`  ${PHRASE.toUpperCase()} `)).toEqual({
      phrase: PHRASE,
      path: undefined,
      passphrase: undefined,
    });
    expect(parseRecovery('xprv9s21ZrQH143K').xprv).toBe('xprv9s21ZrQH143K');
  });

  test('padded hardened step matches the SDK; the old way matches when no leading zero', () => {
    const master = HD.fromSeed(Mnemonic.fromString(PHRASE).toSeed(''));
    for (const i of [44, 145, 236, 0, 7]) {
      expect(hardenedChild(master, i, true).privKey.toWif()).toBe(master.derive(`m/${i}'`).privKey.toWif());
    }
    // This phrase's keys have no leading zero byte, so both ways agree.
    const old = accountKeyNonCompliant(PHRASE, '', "m/44'/145'/0'")!;
    expect(addressAt(old, 'x', 0, 0).address).toBe(
      addressAt(accountKey(PHRASE, '', "m/44'/145'/0'"), 'x', 0, 0).address,
    );
    expect(accountKeyNonCompliant(PHRASE, '', "m/44'/0/0'")).toBeNull();
  });

  test('old derivation matches bitcore deriveNonCompliantChild (vector checked against bsv@1.5.6)', () => {
    const m = 'cradle wheat favorite smooth teach load push stumble mystery latin armor envelope';
    expect(addressAt(accountKey(m, '', "m/44'/145'/0'"), 'x', 0, 0).address).toBe('1GZ9nurYRebuqzsHgpQAaBvnX73bxZPLXG');
    expect(addressAt(accountKeyNonCompliant(m, '', "m/44'/145'/0'")!, 'x', 0, 0).address).toBe(
      '17vjDUxjiQco1Kdx2GyqDTau2yzkqdJwhN',
    );
  });
});
