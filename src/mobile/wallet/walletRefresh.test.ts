import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { routeFor } from '../tabs/tabs';
import { WALLET_HOME_ROUTE } from './walletRefresh';

const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');

describe('sweep Done / wallet refresh', () => {
  test('Done goes to the route the bottom nav Wallet uses', () => {
    expect(WALLET_HOME_ROUTE).toBe(routeFor('bsv')!);
  });
  test('Done uses finish (wallet home); Back still leaves to Settings', () => {
    const src = read('src/mobile/sweep/HdSweepScreen.tsx');
    expect(src).toMatch(/onClick=\{finish\}[\s\S]{0,200}Done/);
    expect(src).toMatch(/const finish = \(\) => \{[\s\S]*?goToWallet\(\)/);
    expect(src).toMatch(/onClick=\{leave\}[^>]*aria-label="Back"/);
    expect(src).toContain('requestWalletRefresh()');
  });
  test('the Wallet home listens for refresh requests', () => {
    expect(read('vite.config.mobile.ts')).toContain('<WalletRefreshListener onRefresh={() => refreshUtxos()} />');
  });
});
