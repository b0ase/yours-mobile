/**
 * Wallet-core reports to b (review of f42df01f, 6; claim-safe drain, review of 6888544a, 6). Where no report outbox is
 * loaded (the extension's background), a report waits in chrome.storage.local under its own key; the app's outbox
 * (mobile/agent/reportOutbox.ts, the extension's pages too) takes each in once, under a lock every page shares.
 */
import { describe, expect, test } from 'bun:test';
import { stubGlobals } from '../testing/stubGlobals';

type Store = Record<string, unknown>;
const local: Store = {};
const pick = (keys: unknown) => {
  if (keys === null) return structuredClone(local);
  const out: Store = {};
  for (const k of typeof keys === 'string' ? [keys] : (keys as string[]))
    if (k in local) out[k] = structuredClone(local[k]);
  return out;
};
const listeners: ((changes: Record<string, unknown>, area: string) => void)[] = [];
const mem = new Map<string, string>();
/** Every storage call yields first, so two drains interleave as two pages' would. */
const tick = () => new Promise((r) => setTimeout(r, 1));
stubGlobals({
  chrome: {
    storage: {
      local: {
        get: async (keys: unknown) => (await tick(), pick(keys)),
        set: async (o: Store) => {
          await tick();
          Object.assign(local, structuredClone(o));
          for (const l of listeners) l(Object.fromEntries(Object.keys(o).map((k) => [k, { newValue: o[k] }])), 'local');
        },
        remove: async (k: string | string[]) => {
          await tick();
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

/** navigator.locks as every extension page shares it: one holder at a time per name. */
const sharedLocks = () => {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const prev = tails.get(name) ?? Promise.resolve();
      const run = prev.then(fn, fn);
      tails.set(
        name,
        run.catch(() => undefined),
      );
      return run;
    },
  };
};
const waitingKeys = (prefix: string) => Object.keys(local).filter((k) => k.startsWith(prefix));

describe('reportSink: the extension background hands reports to the app outbox', () => {
  test('no outbox here: each report waits under its own key; the outbox takes it in when it loads', async () => {
    const sink = await import('./reportSink');
    sink.setReportSink(undefined); // the extension's background: no outbox in it
    // Written at once, as the background could: neither is lost (no list rewritten).
    const [a, b] = await Promise.all([
      sink.reportFromWallet('1Acct', "bWalletX: our storage server's backup could not be rebuilt"),
      sink.reportFromWallet('1Acct', 'a second one'),
    ]);
    expect([a, b]).toEqual([true, true]);
    expect(waitingKeys(sink.WALLET_REPORT_PREFIX).length).toBe(2);
    const outbox = await import('../mobile/agent/reportOutbox');
    outbox.joinWalletReports(); // as at load (the module may already be loaded in this process)
    for (let i = 0; i < 100 && waitingKeys(sink.WALLET_REPORT_PREFIX).length; i++) await tick();
    expect(waitingKeys(sink.WALLET_REPORT_PREFIX)).toEqual([]);
    expect(
      outbox
        .queuedFor('1Acct')
        .map((r) => r.text)
        .sort(),
    ).toEqual(['a second one', "bWalletX: our storage server's backup could not be rebuilt"]);
    // With the outbox loaded, a report goes straight in.
    expect(await sink.reportFromWallet('1Acct', 'straight in')).toBe(true);
    expect(outbox.queuedFor('1Acct').map((r) => r.text)).toContain('straight in');
  });

  test('two pages drain at once: each report taken exactly once; one written mid-drain is not lost', async () => {
    const sink = await import('./reportSink');
    listeners.length = 0; // no page open now: only these drains take reports
    for (const k of waitingKeys(sink.WALLET_REPORT_PREFIX)) delete local[k];
    for (let i = 0; i < 5; i++) await sink.queueForOutbox('1B', `report ${i}`);
    const locks = sharedLocks();
    const taken: string[] = [];
    const take = (_a: string | null | undefined, t: string) => void taken.push(t);
    const late = (async () => {
      await tick();
      await sink.queueForOutbox('1B', 'written mid-drain');
    })();
    await Promise.all([sink.drainPendingWalletReports(take, locks), sink.drainPendingWalletReports(take, locks), late]);
    await sink.drainPendingWalletReports(take, locks); // the next drain (a page's listener, or the next load)
    expect(taken.slice().sort()).toEqual([
      'report 0',
      'report 1',
      'report 2',
      'report 3',
      'report 4',
      'written mid-drain',
    ]);
    expect(new Set(taken).size).toBe(taken.length);
    expect(waitingKeys(sink.WALLET_REPORT_PREFIX)).toEqual([]);
  });

  test('at most 20 wait (the oldest go): a repeating failure never fills storage', async () => {
    const sink = await import('./reportSink');
    listeners.length = 0; // no page open now: only these drains take reports
    for (const k of waitingKeys(sink.WALLET_REPORT_PREFIX)) delete local[k];
    for (let i = 0; i < 25; i++) await sink.queueForOutbox('1C', `r${i}`);
    const kept = waitingKeys(sink.WALLET_REPORT_PREFIX).map((k) => (local[k] as { text: string }).text);
    expect(kept.length).toBe(20);
    expect(kept).not.toContain('r0');
    expect(kept).toContain('r24');
  });
});
