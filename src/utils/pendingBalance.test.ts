import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { stubGlobals } from '../testing/stubGlobals';

/** The background's GET_BALANCE answer: the total in `data` (as sites read it) and the part not yet in a block. */
let answer: Record<string, unknown> = {};
stubGlobals({
  chrome: {
    runtime: {
      lastError: undefined,
      sendMessage: (_m: unknown, cb: (r: unknown) => void) => cb(answer),
    },
  },
});

describe('the pending split reaches the Wallet card', () => {
  test('getWalletBalance returns the total and publishes the pending part; a later answer clears it', async () => {
    const { getWalletBalance } = await import('./wallet');
    const { pendingSatsNow, subscribePendingSats } = await import('./pendingBalance');
    let heard = 0;
    const off = subscribePendingSats(() => heard++);
    answer = { success: true, data: 14_675_380, pending: 6_065_200 };
    expect(await getWalletBalance()).toBe(14_675_380);
    expect(pendingSatsNow()).toBe(6_065_200);
    answer = { success: true, data: 14_675_380, pending: 6_065_200 };
    await getWalletBalance();
    expect(heard).toBe(1); // unchanged: no re-render
    answer = { success: true, data: 14_675_380 }; // an older background: nothing pending
    await getWalletBalance();
    expect(pendingSatsNow()).toBe(0);
    expect(heard).toBe(2);
    off();
  });

  test('the card shows "pending" from that store, hidden with the balance, never more than the balance', () => {
    const src = readFileSync(new URL('../mobile/wallet/WalletCard.tsx', import.meta.url), 'utf8');
    expect(src).toContain('useSyncExternalStore(subscribePendingSats, pendingSatsNow');
    expect(src).toMatch(/const incoming = Math\.min\(\s*Math\.max\(0, sats\),\s*useSyncExternalStore\(/);
    expect(src).toMatch(/incoming > 0 && !balanceHidden && \(\s*<span className="bw-wcard-pending"/);
    expect(src).toMatch(/\{' '\}\s*pending\s*<\/span>/);
    const bg = readFileSync(new URL('../background.ts', import.meta.url), 'utf8');
    expect(bg).toMatch(/\.balanceSplit\(\)\s*\.then\(\(\{ total, pending \}\)/);
    expect(bg).toMatch(/data: total,\s*pending,/);
  });
});
