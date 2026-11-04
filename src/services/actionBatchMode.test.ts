import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { actionBatchIsLegacy, forceLegacyActionBatch, requireLegacyForNoSend } from './actionBatchMode';

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

describe('review 4 Nov 2026 F10: if legacy mode is off, a noSend payment is refused, never held in memory', () => {
  test('noSend refused while the mode is auto; allowed once legacy; other calls untouched', async () => {
    const calls: unknown[] = [];
    const w = {
      actionBatch: { mode: 'auto' },
      createAction: async (a: unknown) => (calls.push(a), { txid: 'x' }),
    };
    expect(requireLegacyForNoSend(w)).toBe(true);
    await expect(w.createAction({ options: { noSend: true } })).rejects.toThrow(/can't keep an unsent payment/);
    expect(calls).toEqual([]);
    await w.createAction({ options: { acceptDelayedBroadcast: false } });
    expect(calls.length).toBe(1);
    w.actionBatch.mode = 'legacy';
    await w.createAction({ options: { noSend: true } });
    expect(calls.length).toBe(2);
  });

  test('initWallet installs it', () => {
    expect(readFileSync('src/initWallet.ts', 'utf8')).toContain('requireLegacyForNoSend(baseWallet)');
  });
});
