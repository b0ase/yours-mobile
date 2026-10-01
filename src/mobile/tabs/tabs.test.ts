import { describe, expect, test } from 'bun:test';
import { opensWalletNfts, routeFor, TAB_ORDER, tabFor } from './tabs';

describe('mobile tabs', () => {
  test('bottom bar order: Apps · Market · Wallet · Feed · Chat, Wallet in the centre', () => {
    expect(TAB_ORDER).toEqual(['browser', 'market', 'bsv', 'feed', 'chat']);
    expect(TAB_ORDER[2]).toBe('bsv');
  });

  test('Feed is a top-level tab with its own route', () => {
    expect(tabFor('feed')).toBe('feed');
    expect(routeFor('feed')).toBe('/m/feed');
  });

  test('upstream ords opens Wallet (NFTs view)', () => {
    expect(tabFor('ords')).toBe('bsv');
    expect(routeFor('ords')).toBe('/bsv-wallet');
    expect(opensWalletNfts('ords')).toBe(true);
    expect(opensWalletNfts('bsv')).toBe(false);
  });

  test('media opens the dedicated Media page', () => {
    expect(routeFor('media')).toBe('/m/media');
    expect(opensWalletNfts('media')).toBe(false);
  });

  test('other tabs unchanged', () => {
    expect(routeFor('market')).toBe('/m/market');
    expect(routeFor('chat')).toBe('/m/chat');
    expect(routeFor('browser')).toBe('/browser');
    expect(tabFor('tools')).toBe('settings');
    expect(tabFor(null)).toBe('bsv');
  });
});
