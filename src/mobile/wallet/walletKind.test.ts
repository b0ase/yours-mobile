import { expect, test } from 'bun:test';
import { getWalletKind, setWalletKind, subscribeWalletKind } from './walletKind';

test('wallet kind store notifies on change only', () => {
  expect(getWalletKind()).toBe('tokens');
  let calls = 0;
  const off = subscribeWalletKind(() => calls++);
  setWalletKind('nfts');
  setWalletKind('nfts');
  expect(getWalletKind()).toBe('nfts');
  expect(calls).toBe(1);
  off();
  setWalletKind('tokens');
  expect(calls).toBe(1);
});
