import { describe, expect, test } from 'bun:test';
import { createChromeShim } from './chromeShim';
import { RECONCILE_RECORD_KEY, type ReconcileRecord } from '../services/storageReconcile';

/**
 * Web edition (web.bwalletx.com): the Repair Log the worker writes reaches the page through the chrome shim, the way
 * useStorageRepair reads it (storage.local.get + storage.onChanged). A minimal hub: one store, replies, broadcasts.
 */
const makeHub = () => {
  const store = new Map<string, unknown>();
  const endpoints: Array<(json: string) => void> = [];
  const timers = {
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => undefined,
  };
  const connect = () => {
    const idx = endpoints.length;
    const shim = createChromeShim({
      post: (json) => {
        const msg = JSON.parse(json) as { t: string; reqId: number; area: string; op: string; arg: unknown };
        if (msg.t !== 'storage') return;
        let result: unknown;
        let changes: Record<string, { oldValue?: unknown; newValue?: unknown }> | undefined;
        if (msg.op === 'get') {
          const keys = typeof msg.arg === 'string' ? [msg.arg] : (msg.arg as string[]);
          result = Object.fromEntries(keys.filter((k) => store.has(k)).map((k) => [k, store.get(k)]));
        } else if (msg.op === 'set') {
          changes = {};
          for (const [k, v] of Object.entries(msg.arg as Record<string, unknown>)) {
            changes[k] = { oldValue: store.get(k), newValue: v };
            store.set(k, v);
          }
        }
        queueMicrotask(() => {
          endpoints[idx](JSON.stringify({ t: 'storageResult', reqId: msg.reqId, result }));
          if (changes) for (const e of endpoints) e(JSON.stringify({ t: 'storageChanged', area: msg.area, changes }));
        });
      },
      parse: (json) => JSON.parse(json),
      rootUrl: 'https://web.bwalletx.com/',
      version: '5.2.14',
      timers,
    });
    endpoints.push(shim.receive);
    return shim.chrome;
  };
  return { connect };
};

describe('Repair Log on the web edition', () => {
  test('a record the worker writes is read and observed by the page', async () => {
    const hub = makeHub();
    const worker = hub.connect();
    const page = hub.connect();
    const seen: unknown[] = [];
    page.storage.onChanged.addListener((changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'local' && RECONCILE_RECORD_KEY in changes) seen.push(changes[RECONCILE_RECORD_KEY].newValue);
    });
    const record: ReconcileRecord = {
      startedAt: 'a',
      finishedAt: 'b',
      trigger: 'manual',
      appVersion: '5.2.14',
      remoteUrl: '',
      verify: { onlyLocal: 0, onlyRemote: 0, mismatched: [] },
      tokens: { recovered: 1, staleDropped: [{ outpoint: 'x.0', tokenId: 'x_0', amt: '21000000' }] },
    };
    await worker.storage.local.set({ [RECONCILE_RECORD_KEY]: record });
    const read = (await page.storage.local.get(RECONCILE_RECORD_KEY))[RECONCILE_RECORD_KEY] as ReconcileRecord;
    expect(read).toEqual(record);
    expect(seen).toEqual([record]);
    // What "Copy Repair Log" copies is not empty.
    expect(JSON.stringify(read, null, 2)).toContain('staleDropped');
  });
});
