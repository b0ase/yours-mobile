import { describe, expect, mock, test } from 'bun:test';

// Native app: a cold start hands the link over via getLaunchUrl, a warm one via appUrlOpen.
const COLD = 'https://www.bwallet.space/pair?v=1&c=cold';
let urlOpen: ((e: { url: string }) => void) | undefined;
mock.module('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
mock.module('@capacitor/app', () => ({
  App: {
    addListener: (ev: string, fn: (e: { url: string }) => void) => {
      if (ev === 'appUrlOpen') urlOpen = fn;
      return Promise.resolve({ remove: () => undefined });
    },
    getLaunchUrl: () => Promise.resolve({ url: COLD }),
  },
}));

const { isPairLink, onPairLink, takePairLink } = await import('./links');

describe('isPairLink', () => {
  test('accepts the pairing links bit-sign and bWalletX produce', () => {
    expect(isPairLink('https://www.bwallet.space/pair?v=1&r=relay.bwallet.space&c=abc&k=02aa&o=https%3A%2F%2Fbit-sign.online&e=1')).toBe(true);
    expect(isPairLink('https://bwallet.space/pair?v=1')).toBe(true);
  });
  test('rejects other hosts and paths', () => {
    expect(isPairLink('https://www.bwallet.space/social#x')).toBe(false);
    expect(isPairLink('https://www.bwallet.space/pairing?v=1')).toBe(false);
    expect(isPairLink('https://evil.example/pair?v=1')).toBe(false);
    expect(isPairLink('https://www.bwallet.space.evil.example/pair')).toBe(false);
    expect(isPairLink('not a url')).toBe(false);
  });
});

describe('app link routing', () => {
  test('cold start: launch URL is held for the pairing screen', async () => {
    await Promise.resolve();
    expect(takePairLink()).toBe(COLD);
    expect(takePairLink()).toBeNull();
  });
  test('warm: appUrlOpen pair link notifies listeners; other URLs are ignored', () => {
    let hits = 0;
    const off = onPairLink(() => hits++);
    urlOpen?.({ url: 'https://www.bwallet.space/social#t=1' });
    expect(hits).toBe(0);
    expect(takePairLink()).toBeNull();
    const warm = 'https://www.bwallet.space/pair?v=1&c=warm';
    urlOpen?.({ url: warm });
    expect(hits).toBe(1);
    expect(takePairLink()).toBe(warm);
    off();
  });
});
