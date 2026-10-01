import { describe, expect, test } from 'bun:test';
import { opensWalletNfts, routeFor, tabFor } from './tabs';

describe('mobile tabs', () => {
  test('Feed is a top-level tab with its own route', () => {
    expect(tabFor('feed')).toBe('feed');
    expect(routeFor('feed')).toBe('/m/feed');
  });

  test('retired Media tab and upstream ords open Wallet (NFTs view)', () => {
    for (const id of ['media', 'ords']) {
      expect(tabFor(id)).toBe('bsv');
      expect(routeFor(id)).toBe('/bsv-wallet');
      expect(opensWalletNfts(id)).toBe(true);
    }
    expect(opensWalletNfts('bsv')).toBe(false);
  });

  test('other tabs unchanged', () => {
    expect(routeFor('market')).toBe('/m/market');
    expect(routeFor('chat')).toBe('/m/chat');
    expect(routeFor('browser')).toBe('/browser');
    expect(tabFor('tools')).toBe('settings');
    expect(tabFor(null)).toBe('bsv');
  });
});
