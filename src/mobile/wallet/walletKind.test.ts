import { expect, test } from 'bun:test';
import { getMediaView, getWalletKind, openMediaView, setWalletKind, subscribeWalletKind } from './walletKind';

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

test('Media view opens NFTs narrowed; switching kind clears it', () => {
  setWalletKind('tokens');
  openMediaView();
  expect(getWalletKind()).toBe('nfts');
  expect(getMediaView()).toBe(true);
  setWalletKind('nfts');
  expect(getMediaView()).toBe(false);
  setWalletKind('tokens');
});
