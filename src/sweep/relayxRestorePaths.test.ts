import { describe, expect, test } from 'bun:test';
import { Mnemonic } from '@bsv/sdk';
import { getKeys } from '../utils/keys';
import { DEFAULT_RELAYX_ORD_PATH } from '../utils/constants';
import { keyAt, relayxAccount } from './relayxRecover';

/**
 * What the inherited Yours "Restore › RelayX" (Keys.service generateSeedAndStoreEncrypted, importWallet 'relayx')
 * actually derives, checked against RelayX's layout (m/44'/236'/0': payments /0/i, change /1/i, NFTs /2/i).
 * Owner, 17 Oct 2026: that code was never tested here. These pin down what it covers, so the NFT finder can fill
 * the rest after a RelayX restore.
 */
describe('Yours RelayX restore: which RelayX addresses it holds', () => {
  const words = Mnemonic.fromRandom().toString();
  const keys = getKeys(words, null, DEFAULT_RELAYX_ORD_PATH, null);
  const acct = relayxAccount(words);

  test('its ordinals key is the first RelayX NFT address (/2/0)', () => {
    expect(keys.ordAddress).toBe(keyAt(acct, 2, 0).address);
  });

  test('its payment key is the first RelayX change address (/1/0), not the first payment address (/0/0)', () => {
    expect(keys.walletAddress).toBe(keyAt(acct, 1, 0).address);
    expect(keys.walletAddress).not.toBe(keyAt(acct, 0, 0).address);
  });

  test('it holds nothing past index 0: /0/i, /1/1… and /2/1… are left out', () => {
    const held = new Set([keys.walletAddress, keys.ordAddress]);
    for (const [chain, i] of [
      [0, 0],
      [0, 1],
      [1, 1],
      [2, 1],
      [2, 5],
    ])
      expect(held.has(keyAt(acct, chain, i).address)).toBe(false);
  });
});
