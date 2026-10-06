import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import {
  buyCryptoEnabled,
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

describe('store build: no buying, no personal token, no bWalletX text', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

  test('buying crypto (Buy BSV, Get BSV, Get MNEE) is bWalletX only', () => {
    expect(buyCryptoEnabled(true)).toBe(false);
    expect(buyCryptoEnabled(false)).toBe(true);
    const wallet = src('../pages/BsvWallet.tsx');
    expect(wallet).toMatch(/buyCryptoEnabled\(\) && \(\s*<BsvPriceBar/);
    expect(wallet).toMatch(/buyCryptoEnabled\(\) && \(\s*<BuyBsvButton/);
    expect(wallet).toContain('bsvBalance === 0 && buyCryptoEnabled()');
    expect(wallet).toContain('onGetMneeClick={buyCryptoEnabled() ?');
  });

  test('Choose your handle: the token + room panel needs paid features (or an existing token)', () => {
    expect(src('./names/HandleFlow.tsx')).toMatch(
      /paidFeaturesEnabled\(\) \|\| link \? \(\s*<div[\s\S]*?Your token \+ room/,
    );
  });

  test('store-reachable screens take the app name from APP_NAME, not a literal bWalletX', () => {
    for (const f of [
      './names/PasswordFields.tsx',
      './onboardingError.ts',
      './settings/ChangePassword.tsx',
      './backup/BackupStep.tsx',
      './bappFrame/BappFrameHost.tsx',
      './tokens/TokenIconHeader.tsx',
      './tabs/ChatPage.tsx',
      './wallet/BuyBsv.tsx',
      './strategies/strategyNft.ts',
      './contracts/contractNft.ts',
    ]) {
      const code = src(f)
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l))
        .join('\n');
      expect([f, /bWalletX/.test(code)]).toEqual([f, false]);
    }
  });
});
