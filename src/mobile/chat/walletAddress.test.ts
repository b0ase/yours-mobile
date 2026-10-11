import { describe, expect, test } from 'bun:test';
import { WALLET_ADDRESS_KEY_ID, WALLET_ADDRESS_PROTOCOL, reportedKey, walletAddressMessage } from './walletAddress';

describe('wallet address report', () => {
  test('message matches bit-sign lib/bwallet-address.ts', () => {
    expect(walletAddressMessage('1BoatSLRHtKNngkdXEeobR76b53LETtpyT', '$AIGF')).toBe(
      'bChatX wallet address 1BoatSLRHtKNngkdXEeobR76b53LETtpyT for aigf',
    );
    expect(WALLET_ADDRESS_PROTOCOL).toEqual([2, 'bwallet sign in']);
    expect(WALLET_ADDRESS_KEY_ID).toBe('wallet-address');
  });
  test('reported key changes with handle or address only', () => {
    expect(reportedKey('$AIGF', 'a')).toBe(reportedKey('aigf', 'a'));
    expect(reportedKey('aigf', 'a')).not.toBe(reportedKey('aigf', 'b'));
  });
});
