import { describe, expect, test } from 'bun:test';
import {
  REFUSED_RETRY_MS,
  WALLET_ADDRESS_KEY_ID,
  WALLET_ADDRESS_PROTOCOL,
  refusedMark,
  refusedRecently,
  reportedKey,
  walletAddressMessage,
} from './walletAddress';

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

test('a refused report is not retried for a day, and only for the same handle and address', () => {
  const key = reportedKey('dkg', 'addr1');
  const mark = refusedMark(key, 1000);
  expect(refusedRecently(mark, key, 1000 + REFUSED_RETRY_MS - 1)).toBe(true);
  expect(refusedRecently(mark, key, 1000 + REFUSED_RETRY_MS)).toBe(false);
  expect(refusedRecently(mark, reportedKey('dkg', 'addr2'), 2000)).toBe(false);
  expect(refusedRecently(key, key, 2000)).toBe(false);
  expect(refusedRecently(null, key, 2000)).toBe(false);
});
