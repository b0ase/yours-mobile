import { describe, expect, test } from 'bun:test';
import {
  localOutbox,
  memoryOutbox,
  OUTBOX_KEEP_MS,
  pruneOutbox,
  sendStorePayment,
  StorePayError,
  type OutboxEntry,
} from './storePay';

const T = 'ab'.repeat(32);
const entry = (over: Partial<OutboxEntry> = {}): OutboxEntry => ({
  kind: 'buy',
  quoteId: 'q'.repeat(32),
  txid: T,
  beefHex: '00',
  key: 'emoji-cool',
  state: 'signed',
  at: 1_000,
  ...over,
});

describe('the Store outbox (P0, 3 Nov 2026)', () => {
  test('localOutbox keeps entries per identity and survives a blocked or broken store', () => {
    const m = new Map<string, string>();
    const kv = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    const a = localOutbox('02aa', kv);
    a.put(entry());
    a.put(entry({ state: 'sent' }));
    expect(a.all()).toEqual([entry({ state: 'sent' })]);
    expect(localOutbox('03bb', kv).all()).toEqual([]);
    a.drop(T);
    expect(a.all()).toEqual([]);
    const broken = localOutbox('02aa', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    });
    broken.put(entry());
    expect(broken.all()).toEqual([]);
    m.set('bwx-store-outbox:02cc', 'not json');
    expect(localOutbox('02cc', kv).all()).toEqual([]);
  });

  test('entries older than the keep time are dropped', () => {
    const o = memoryOutbox();
    o.put(entry({ at: 0 }));
    o.put(entry({ txid: 'cd'.repeat(32), at: OUTBOX_KEEP_MS }));
    expect(pruneOutbox(o, OUTBOX_KEEP_MS + 1).map((e) => e.txid)).toEqual(['cd'.repeat(32)]);
  });

  test("the wallet couldn't send it and the chain doesn't have it: kept to send again, nothing claimed", async () => {
    const o = memoryOutbox();
    const wallet = {
      abortAction: async () => {
        throw new Error('never');
      },
      createAction: async () => {
        throw new Error('offline');
      },
    };
    const e = await sendStorePayment(wallet, entry(), {
      backup: async () => ({ ok: true }),
      outbox: o,
      lookups: [async () => 'missing'],
      log: () => undefined,
    }).then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(StorePayError);
    expect((e as StorePayError).code).toBe('not_sent');
    expect((e as StorePayError).sent).toBe(true);
    expect(o.all()[0].state).toBe('sending');
  });

  test('backup first: a failed backup never reaches the wallet send', async () => {
    let sends = 0;
    const wallet = {
      abortAction: async () => undefined,
      createAction: async () => (sends++, {}),
    };
    const o = memoryOutbox();
    await expect(
      sendStorePayment(wallet, entry(), {
        backup: async () => ({ ok: false, error: 'offline' }),
        outbox: o,
        log: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'backup_failed', sent: false });
    expect(sends).toBe(0);
    expect(o.all()).toEqual([]);
  });
});
