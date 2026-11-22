/**
 * Wallet-core reports to b (review of f42df01f, 6). Where no report outbox is loaded (the extension's background), a
 * report waits in chrome.storage.local; the app's outbox (mobile/agent/reportOutbox.ts, the extension's pages too)
 * takes it in when it loads, and sends it with its retries and redaction like any other report.
 */
import { describe, expect, test } from 'bun:test';
import { stubGlobals } from '../testing/stubGlobals';

type Store = Record<string, unknown>;
const local: Store = {};
const pick = (keys: unknown) => {
  const out: Store = {};
  for (const k of typeof keys === 'string' ? [keys] : (keys as string[]))
    if (k in local) out[k] = structuredClone(local[k]);
  return out;
};
const listeners: ((changes: Record<string, unknown>, area: string) => void)[] = [];
const mem = new Map<string, string>();
stubGlobals({
  chrome: {
    storage: {
      local: {
        get: async (keys: unknown) => pick(keys),
        set: async (o: Store) => {
          Object.assign(local, structuredClone(o));
          for (const l of listeners) l(Object.fromEntries(Object.keys(o).map((k) => [k, { newValue: o[k] }])), 'local');
        },
        remove: async (k: string | string[]) => {
          for (const x of typeof k === 'string' ? [k] : k) delete local[x];
        },
      },
      onChanged: { addListener: (l: (typeof listeners)[number]) => void listeners.push(l) },
    },
  },
  localStorage: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  },
});

describe('reportSink: the extension background hands reports to the app outbox', () => {
  test('no outbox here: the report waits in chrome.storage; the outbox takes it in when it loads', async () => {
    const sink = await import('./reportSink');
    sink.setReportSink(undefined); // the extension's background: no outbox in it
    expect(await sink.reportFromWallet('1Acct', "bWalletX: our storage server's backup could not be rebuilt")).toBe(
      true,
    );
    expect(await sink.reportFromWallet('1Acct', 'a second one')).toBe(true);
    expect((local[sink.PENDING_WALLET_REPORTS_KEY] as unknown[]).length).toBe(2);
    // The app (or the extension's page) loads its outbox (which runs joinWalletReports): both reports join it and
    // leave chrome.storage.
    const outbox = await import('../mobile/agent/reportOutbox');
    outbox.joinWalletReports(); // as at load (the module may already be loaded in this process)
    for (let i = 0; i < 50 && local[sink.PENDING_WALLET_REPORTS_KEY] !== undefined; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(local[sink.PENDING_WALLET_REPORTS_KEY]).toBeUndefined();
    expect(outbox.queuedFor('1Acct').map((r) => r.text)).toEqual([
      "bWalletX: our storage server's backup could not be rebuilt",
      'a second one',
    ]);
    // With the outbox loaded, a report goes straight in.
    expect(await sink.reportFromWallet('1Acct', 'straight in')).toBe(true);
    expect(outbox.queuedFor('1Acct').map((r) => r.text)).toContain('straight in');
  });

  test('a report waiting while the outbox is open (background writes, page listening) joins it too', async () => {
    const sink = await import('./reportSink');
    const outbox = await import('../mobile/agent/reportOutbox');
    const before = outbox.queuedFor('1Acct').length;
    // The background's copy of the module has no sink: it writes to chrome.storage, the page's listener takes it.
    await sink.queueForOutbox('1Acct', 'from the background');
    for (let i = 0; i < 50 && local[sink.PENDING_WALLET_REPORTS_KEY] !== undefined; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(outbox.queuedFor('1Acct').length).toBe(before + 1);
    expect(local[sink.PENDING_WALLET_REPORTS_KEY]).toBeUndefined();
  });
});
