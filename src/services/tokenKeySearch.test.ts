import { describe, expect, test } from 'bun:test';
import { KeyDeriver, PrivateKey, PublicKey, Utils } from '@bsv/sdk';
import { buildKeySearchSetup, derivedHash160, invoicePrefixFor, searchMsKeyIDs } from './tokenKeySearch';

const PROTOCOL: [0, string] = [0, 'onesat'];
const priv = PrivateKey.fromRandom();
const deriver = new KeyDeriver(priv);
const sdkHash160 = (keyID: string) =>
  Utils.toHex(
    PublicKey.fromString(deriver.derivePublicKey(PROTOCOL, keyID, 'self', true).toString()).toHash() as number[],
  );
const setup = buildKeySearchSetup(priv.toWif(), invoicePrefixFor(PROTOCOL));

describe('tokenKeySearch', () => {
  test('fast derivation matches the SDK KeyDeriver (self, forSelf)', () => {
    for (const keyID of ['abc_0-1791266000000', '1sat 0', 'x']) {
      expect(derivedHash160(setup, keyID)).toBe(sdkHash160(keyID));
    }
  });

  test('finds the millisecond keyID of token change inside the window', async () => {
    const tokenId = 'ab'.repeat(32) + '_0';
    const ms = 1791266000123;
    const target = sdkHash160(`${tokenId}-${ms}`);
    const hits = await searchMsKeyIDs({
      setup,
      keyIDPrefix: `${tokenId}-`,
      targets: new Set([target]),
      fromMs: ms - 700,
      toMs: ms + 300,
      yieldFn: async () => {},
    });
    expect(hits).toEqual([{ hash160: target, keyID: `${tokenId}-${ms}` }]);
  });

  test('returns nothing when the key is outside the window', async () => {
    const hits = await searchMsKeyIDs({
      setup,
      keyIDPrefix: 'z-',
      targets: new Set([sdkHash160('z-5000')]),
      fromMs: 1000,
      toMs: 1200,
      yieldFn: async () => {},
    });
    expect(hits).toEqual([]);
  });
});
