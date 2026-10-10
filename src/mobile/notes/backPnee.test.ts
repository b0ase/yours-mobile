import { describe, expect, test } from 'bun:test';
import {
  BACK_PNEE_DONE_HINT,
  BACK_PNEE_ROUTE,
  backPneeDoneTitle,
  backPneeSummary,
  isBackPneeMode,
  nextBackPneeStep,
  parseBsvAmount,
} from './backPnee';

describe('Back PNEEs entry', () => {
  test('route opens the lock screen in back mode', () => {
    expect(BACK_PNEE_ROUTE.startsWith('/m/lock')).toBe(true);
    expect(isBackPneeMode(BACK_PNEE_ROUTE.slice(BACK_PNEE_ROUTE.indexOf('?')))).toBe(true);
    expect(isBackPneeMode('')).toBe(false);
    expect(isBackPneeMode('?tx=abc')).toBe(false);
  });
  test('parses amounts', () => {
    expect(parseBsvAmount('1')).toBe(1);
    expect(parseBsvAmount(' 0,5 ')).toBe(0.5);
    expect(parseBsvAmount('.25')).toBe(0.25);
    expect(parseBsvAmount('0.00000001')).toBe(1e-8);
    expect(parseBsvAmount('0.000000001')).toBeNull();
    expect(parseBsvAmount('0')).toBeNull();
    expect(parseBsvAmount('')).toBeNull();
    expect(parseBsvAmount('-1')).toBeNull();
    expect(parseBsvAmount('abc')).toBeNull();
  });
  test('summary at 10x collateral', () => {
    expect(backPneeSummary(1, 50)).toEqual({ usd: 50, maxPneeUsd: 5 });
    expect(backPneeSummary(0.5, 33.33)).toEqual({ usd: 16.67, maxPneeUsd: 1.66 });
    expect(backPneeSummary(1, 0)).toEqual({ usd: 0, maxPneeUsd: 0 });
  });
});

describe('Back PNEEs flow order (owner, 10 Oct 2026)', () => {
  const run = (evs: Parameters<typeof nextBackPneeStep>[1][]) =>
    evs.reduce<ReturnType<typeof nextBackPneeStep>[]>(
      (acc, ev) => [...acc, nextBackPneeStep(acc[acc.length - 1], ev)],
      ['card'],
    );
  test('card → amount → build → done → wallet', () => {
    expect(run(['lock', 'continue', 'locked', 'toWallet'])).toEqual(['card', 'amount', 'build', 'done', 'wallet']);
  });
  test('the card always comes first: continue/locked do nothing on the card', () => {
    expect(nextBackPneeStep('card', 'continue')).toBe('card');
    expect(nextBackPneeStep('card', 'locked')).toBe('card');
  });
  test('closing early returns to the Wallet, never Pots & Locks', () => {
    expect(nextBackPneeStep('card', 'close')).toBe('wallet');
    expect(nextBackPneeStep('amount', 'close')).toBe('wallet');
    expect(nextBackPneeStep('build', 'close')).toBe('wallet');
    expect(nextBackPneeStep('done', 'close')).toBe('wallet');
  });
  test('back walks the steps backwards', () => {
    expect(nextBackPneeStep('build', 'back')).toBe('amount');
    expect(nextBackPneeStep('amount', 'back')).toBe('card');
  });
  test('Pots & Locks only when chosen on the done card', () => {
    expect(nextBackPneeStep('done', 'toPots')).toBe('pots');
    expect(['card', 'amount', 'build'].map((s) => nextBackPneeStep(s as never, 'toPots'))).toEqual([
      'card',
      'amount',
      'build',
    ]);
  });
  test('done card text', () => {
    expect(backPneeDoneTitle(0.5)).toBe('Locked 0.5 BSV to back PNEEs.');
    expect(BACK_PNEE_DONE_HINT).toContain('Pots & Locks');
  });
  test('LockScreen reads the router location, not window.location (MemoryRouter never sets window.location.search)', async () => {
    const src = await Bun.file(new URL('../locks/LockScreen.tsx', import.meta.url)).text();
    expect(src).toContain('isBackPneeMode(location.search)');
    expect(src).not.toContain('isBackPneeMode(window.location.search)');
  });
});
