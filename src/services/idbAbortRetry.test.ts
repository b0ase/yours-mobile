import { describe, expect, test } from 'bun:test';
import { IDB_ABORT_RETRY_MS, isIdbAbort, retryOnceOnIdbAbort, retryReadsOnIdbAbort } from './idbAbortRetry';

/**
 * Owner's iPhone, 7 Nov 2026 12:28:25 (test/phone-1107, first launch): "Wallet sync failing: address sync: IDB
 * transaction aborted". WebKit aborts open IndexedDB transactions when it suspends the app; the permission store's
 * withStore then rejects with that message (no tx.error). Nothing was written; the run just has to go again.
 */
const aborted = () => new Error('IDB transaction aborted');
const domAbort = () =>
  Object.assign(new Error('The transaction was aborted, so the request cannot be fulfilled.'), { name: 'AbortError' });

describe('isIdbAbort', () => {
  test('the permission store message and a DOM AbortError; nothing else', () => {
    expect(isIdbAbort(aborted())).toBe(true);
    expect(isIdbAbort(domAbort())).toBe(true);
    expect(isIdbAbort(new Error('IDB transaction failed'))).toBe(false); // a real request error
    expect(isIdbAbort(new Error('network: the backup did not answer in time'))).toBe(false);
    expect(isIdbAbort(null)).toBe(false);
  });
});

describe('retryOnceOnIdbAbort (the address sync, initWallet)', () => {
  const run = (answers: (Error | string)[]) => {
    let calls = 0;
    const waits: number[] = [];
    const p = retryOnceOnIdbAbort(
      async () => {
        const a = answers[calls++];
        if (a instanceof Error) throw a;
        return a;
      },
      { sleep: async (ms) => void waits.push(ms) },
    );
    return { p, calls: () => calls, waits };
  };
  test('an abort, then success: one retry after IDB_ABORT_RETRY_MS, no error (so no banner)', async () => {
    const r = run([aborted(), 'ok']);
    expect(await r.p).toBe('ok');
    expect(r.calls()).toBe(2);
    expect(r.waits).toEqual([IDB_ABORT_RETRY_MS]);
  });
  test('two aborts: the second error is thrown (the banner shows), and no third try', async () => {
    const r = run([aborted(), domAbort(), 'never']);
    await expect(r.p).rejects.toThrow('aborted');
    expect(r.calls()).toBe(2);
  });
  test('any other error: thrown at once, never retried', async () => {
    const r = run([new Error('WoC 500'), 'never']);
    await expect(r.p).rejects.toThrow('WoC 500');
    expect(r.calls()).toBe(1);
    expect(r.waits).toEqual([]);
  });
});

describe('retryReadsOnIdbAbort (the account permission store)', () => {
  const store = (failures: number) => {
    let reads = 0;
    let writes = 0;
    const s = {
      findGrant: async (k: string) => {
        if (reads++ < failures) throw aborted();
        return `grant:${k}`;
      },
      listGrants: async () => {
        if (reads++ < failures) throw aborted();
        return ['g'];
      },
      putGrant: async () => {
        writes++;
        throw aborted();
      },
    };
    return { s: retryReadsOnIdbAbort(s), reads: () => reads, writes: () => writes };
  };
  test('an aborted read is read again once', async () => {
    const a = store(1);
    expect(await a.s.findGrant('x')).toBe('grant:x');
    expect(a.reads()).toBe(2);
    const b = store(1);
    expect(await b.s.listGrants()).toEqual(['g']);
  });
  test('two aborted reads: the error stands', async () => {
    const a = store(2);
    await expect(a.s.findGrant('x')).rejects.toThrow('aborted');
    expect(a.reads()).toBe(2);
  });
  test('writes are never retried here (a write may have landed)', async () => {
    const a = store(0);
    await expect(a.s.putGrant()).rejects.toThrow('aborted');
    expect(a.writes()).toBe(1);
  });
});
