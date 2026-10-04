import { describe, expect, test } from 'bun:test';
import {
  STORE_BUILD,
  agentModeFor,
  bcorpFeeAddress,
  marketFiltersFor,
  marketTradingEnabled,
  marketLabel,
  isBWalletX,
  appNameFor,
  mintChoicesFor,
  paidFeaturesEnabled,
  tokenRoomsEnabled,
  walletKindsFor,
} from './storeBuild';
import { parseAgentPrefs } from './agent/agentPrefs';

const KINDS = [
  ['tokens', 'Tokens'],
  ['nfts', 'NFTs'],
  ['tickets', 'Tickets'],
  ['credits', 'Credits'],
] as const;
const FILTERS = [
  ['all', 'All tokens', true],
  ['bapps', 'bApps', true],
  ['tickets', 'Tickets', true],
] as const;

describe('storeBuild', () => {
  test('default (test) build is not a store build', () => {
    expect(STORE_BUILD).toBe(false);
    // The live default leaves paid mode alone.
    expect(parseAgentPrefs({ mode: 'paid' }).mode).toBe('paid');
  });

  test('b agent: own key only in a store build', () => {
    expect(agentModeFor('paid', true)).toBe('own');
    expect(agentModeFor('own', true)).toBe('own');
    expect(agentModeFor('paid', false)).toBe('paid');
  });

  test('no bCorp fee address in a store build', () => {
    expect(bcorpFeeAddress('1BoatSLRHtKNngkdXEeobR76b53LETtpyT', true)).toBe('');
    expect(bcorpFeeAddress('1BoatSLRHtKNngkdXEeobR76b53LETtpyT', false)).toBe('1BoatSLRHtKNngkdXEeobR76b53LETtpyT');
  });

  test('wallet kinds: no Tickets / Credits in a store build', () => {
    expect(walletKindsFor(KINDS, true).map((k) => k[0])).toEqual(['tokens', 'nfts']);
    expect(walletKindsFor(KINDS, false).map((k) => k[0])).toEqual(['tokens', 'nfts', 'tickets', 'credits']);
  });

  test('market filters: no bApps / Tickets in a store build', () => {
    expect(marketFiltersFor(FILTERS, true).map((f) => f[0])).toEqual(['all', 'bapps']);
    expect(marketFiltersFor(FILTERS, false)).toHaveLength(3);
  });

  test('trading, token rooms, paid features and mint choices', () => {
    expect(marketTradingEnabled(true)).toBe(false);
    expect(marketTradingEnabled(false)).toBe(true);
    expect(tokenRoomsEnabled(true)).toBe(false);
    expect(tokenRoomsEnabled(false)).toBe(true);
    expect(paidFeaturesEnabled(true)).toBe(false);
    expect(paidFeaturesEnabled(false)).toBe(true);
    expect(mintChoicesFor(true)).toEqual(['token', 'media']);
    expect(mintChoicesFor(false)).toEqual(['ticket', 'token', 'media']);
  });

  test('bWalletX branding outside the store build', () => {
    expect(isBWalletX(true)).toBe(false);
    expect(isBWalletX(false)).toBe(true);
    expect(appNameFor(true)).toBe('bWallet');
    expect(appNameFor(false)).toBe('bWalletX');
  });
  test('marketLabel: Exchange in bWalletX, Market in the store app', () => {
    expect(marketLabel(false)).toBe('Exchange');
    expect(marketLabel(true)).toBe('Market');
  });
});
