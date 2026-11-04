import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { actionBatchIsLegacy, forceLegacyActionBatch } from './actionBatchMode';

describe('no payment lives only in memory (P0, 3 Nov 2026)', () => {
  test('sets the batch controller to legacy; false when there is none', () => {
    const w = { actionBatch: { mode: 'auto' } };
    expect(forceLegacyActionBatch(w)).toBe(true);
    expect(w.actionBatch.mode).toBe('legacy');
    expect(actionBatchIsLegacy(w)).toBe(true);
    expect(forceLegacyActionBatch({})).toBe(false);
    expect(forceLegacyActionBatch(null)).toBe(false);
  });

  test('initWallet forces it on the wallet createWebWallet built, before anything can sign', () => {
    const src = readFileSync('src/initWallet.ts', 'utf8');
    const built = src.indexOf('} = await createWebWallet(walletConfig)');
    const forced = src.indexOf('forceLegacyActionBatch(baseWallet)');
    const firstUse = src.indexOf('guardSpending(baseWallet)');
    expect(built).toBeGreaterThan(0);
    expect(forced).toBeGreaterThan(built);
    expect(forced).toBeLessThan(firstUse);
  });
});
