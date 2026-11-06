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

  test('the card shows "pending" from that store: hidden with the balance, never more than it, dollars or sats', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { createElement } = await import('react');
    const { PendingLine } = await import('../mobile/wallet/PendingLine');
    const html = (p: Parameters<typeof PendingLine>[0]) => renderToStaticMarkup(createElement(PendingLine, p));
    const base = { sats: 14_675_380, pending: 6_065_200, unit: 'bsv' as const, rate: 0, hidden: false };
    expect(html(base)).toContain('6,065,200 sats pending');
    expect(html({ ...base, unit: 'usd', rate: 16.5 })).toMatch(/\$1\.00 pending/);
    expect(html({ ...base, hidden: true })).toBe('');
    expect(html({ ...base, pending: 0 })).toBe('');
    expect(html({ ...base, sats: 1_000, pending: 6_065_200 })).toContain('1,000 sats pending'); // never more than shown
    // The card renders it from the store getWalletBalance publishes (utils/pendingBalance.ts).
    const card = readFileSync(new URL('../mobile/wallet/WalletCard.tsx', import.meta.url), 'utf8');
    expect(card).toContain('useSyncExternalStore(subscribePendingSats, pendingSatsNow');
    expect(card).toMatch(/<PendingLine sats=\{sats\} pending=\{incoming\}/);
  });
});
