import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  MOVE_REPORT_PREFIX,
  MOVE_REPORT_TTL_MS,
  MOVE_REPORTS_PER_DAY,
  moveReasonKey,
  recordMoveOutcome,
  redactMoveReason,
  reportMoveFailure,
  sameAsNow,
  type MoveReportStore,
} from './moveFailureReport';
import type { EnsureLocalResult } from './localFirst';

/** chrome.storage.local as it outlives a service-worker start or app launch: the same map, new callers. */
const persistent = () => {
  const m = new Map<string, unknown>();
  const store: MoveReportStore = {
    get: async (k) => (m.has(k) ? { [k]: structuredClone(m.get(k)) } : {}),
    set: async (items) => void Object.entries(items).forEach(([k, v]) => m.set(k, structuredClone(v))),
  };
  return { m, store };
};
const failed = (reason?: string): EnsureLocalResult => ({ ok: false, how: 'failed', reason });

describe('move failures reach b once a day per reason, across restarts (review of #557, M1)', () => {
  test('the same failure on every launch is reported once; counts and timeouts in the reason do not matter', async () => {
    const { store } = persistent();
    const sent: { account: string; text: string; id: string }[] = [];
    const send = (account: string, text: string, id: string) => void sent.push({ account, text, id });
    const t0 = 1_800_000_000_000;
    // Ten launches in a day, each a fresh worker (nothing in memory), each the same failure with new numbers.
    for (let i = 0; i < 10; i++)
      await reportMoveFailure({
        r: failed(`backup short: ${3 + i} of ${120 + i} outputs missing after ${30_000 + i * 7} ms`),
        account: '1Acct',
        failures: i + 1,
        store,
        send,
        now: t0 + i * 60 * 60_000,
      });
    expect(sent.length).toBe(1);
    expect(sent[0].text).toBe(
      "Moving this account to this device didn't finish (try 1): backup short: 3 of 120 outputs missing after 30000 ms",
    );
    // The id is reportOutbox's form, so the outbox sends it as message_id bwx-report:<id>.
    expect(sent[0].id).toMatch(/^[0-9a-z]+-[0-9a-f]{16}$/);
    // A day later it may be reported again, under a new id.
    expect(
      await reportMoveFailure({
        r: failed('backup short: 9 of 9'),
        account: '1Acct',
        failures: 11,
        store,
        send,
        now: t0 + MOVE_REPORT_TTL_MS + 1,
      }),
    ).toBe('sent');
    expect(sent[1].id).not.toBe(sent[0].id);
  });

  test('at most 3 different reasons per account a day; another account has its own count', async () => {
    const { store } = persistent();
    const sent: string[] = [];
    const send = (a: string, t: string) => void sent.push(`${a}:${t}`);
    const results: string[] = [];
    for (const reason of ['timeout', 'store closed', 'not initialized', 'disk full', 'quota'])
      results.push(await reportMoveFailure({ r: failed(reason), account: 'A', failures: 1, store, send, now: 1000 }));
    expect(results).toEqual(['sent', 'sent', 'sent', 'capped', 'capped']);
    expect(MOVE_REPORTS_PER_DAY).toBe(3);
    expect(await reportMoveFailure({ r: failed('disk full'), account: 'B', failures: 1, store, send, now: 1000 })).toBe(
      'sent',
    );
    expect(sent.length).toBe(4);
  });

  test('kept in storage per account, before the send', async () => {
    const { m, store } = persistent();
    let seenAtSend: unknown;
    await reportMoveFailure({
      r: failed('timeout'),
      account: 'A',
      failures: 1,
      store,
      send: () => void (seenAtSend = m.get(`${MOVE_REPORT_PREFIX}A`)),
      now: 5,
    });
    expect((seenAtSend as { entries: unknown[] }).entries.length).toBe(1);
  });

  test('only a failed move is reported; no account, no report', async () => {
    const { store } = persistent();
    const send = () => {
      throw new Error('should not send');
    };
    for (const r of [
      { ok: true, how: 'switched' },
      { ok: false, how: 'failed-this-session', reason: 'x' },
      { ok: false, how: 'busy' },
      { ok: false, how: 'no-account' },
    ] as EnsureLocalResult[])
      expect(await reportMoveFailure({ r, account: 'A', failures: 1, store, send })).toBe('none');
    expect(await reportMoveFailure({ r: failed('x'), account: undefined, failures: 1, store, send })).toBe('none');
  });

  test('reasons are redacted before they are cut: ids, hashes and query strings never reach b', () => {
    const txid = 'ab'.repeat(32);
    const r = redactMoveReason(
      `GET https://wallet.1sat.app/api/sync?user=02${'cd'.repeat(32)}&token=s3cr3t#frag failed for ${txid}`,
    );
    expect(r).toBe('GET https://wallet.1sat.app/api/sync failed for …');
    expect(r).not.toContain('s3cr3t');
    // A long reason with an id at the cut: the id goes first, so no half of it survives.
    const long = redactMoveReason(`${'x '.repeat(149)}${txid}`);
    expect(long).not.toMatch(/[0-9a-f]{8,}/);
    expect(redactMoveReason('z'.repeat(400)).length).toBe(300);
    expect(moveReasonKey('took 30000 ms')).toBe(moveReasonKey('took 45123 ms'));
    expect(moveReasonKey('took 30000 ms')).not.toBe(moveReasonKey('store closed'));
  });
});

describe("a move's outcome is filed under the account it ran for (review of #557, M2)", () => {
  test('an account switch (or lock) during the move: no report, no backoff reason written for either account', async () => {
    let account = 'A';
    let gen = 1;
    const ctx = {};
    let current: object | null = ctx;
    const still = sameAsNow(() => [current, gen, account]);
    // The move runs; meanwhile the user switches to B.
    account = 'B';
    current = {};
    const failures = new Map([
      ['A', { failures: 2, nextAt: 0 }],
      ['B', { failures: 1, nextAt: 0, reason: 'B own reason' }],
    ]);
    const reported: string[] = [];
    const out = await recordMoveOutcome({
      r: failed("A's reason"),
      account: 'A',
      stillCurrent: still,
      failures,
      report: async (a) => void reported.push(a),
    });
    expect(out).toBe('stale');
    expect(reported).toEqual([]);
    expect(failures.get('A')).toEqual({ failures: 2, nextAt: 0 });
    expect(failures.get('B')?.reason).toBe('B own reason');
    // A lock alone (same account, new lock generation) counts too.
    account = 'A';
    current = ctx;
    gen = 2;
    expect(still()).toBe(false);
  });

  test('still the same wallet: the reason is noted on that account and reported with its try count', async () => {
    const failures = new Map([['A', { failures: 3, nextAt: 0 }]]);
    const reported: [string, number][] = [];
    const out = await recordMoveOutcome({
      r: failed('timeout'),
      account: 'A',
      stillCurrent: () => true,
      failures,
      report: async (a, n) => void reported.push([a, n]),
    });
    expect(out).toBe('noted');
    expect(failures.get('A')?.reason).toBe('timeout');
    expect(reported).toEqual([['A', 3]]);
    // A success clears that account's failures, whatever is open now.
    expect(
      await recordMoveOutcome({
        r: { ok: true, how: 'switched' },
        account: 'A',
        stillCurrent: () => false,
        failures,
        report: async () => undefined,
      }),
    ).toBe('ok');
    expect(failures.has('A')).toBe(false);
  });

  test('wired: the account and lock are read before the move, and the report is kept in chrome.storage.local', () => {
    const bg = readFileSync('src/background.ts', 'utf8');
    const once = bg.slice(bg.indexOf('const preferLocalStorageOnce'), bg.indexOf('const addSnapshotRemote'));
    const captured = once.indexOf(
      'const stillCurrent = sameAsNow(() => [accountContext, lockGeneration, currentAccountId()]);',
    );
    const idRead = once.indexOf('const id = currentAccountId();');
    const moved = once.indexOf('await settleLocalStore(ctx)');
    expect(captured).toBeGreaterThan(0);
    expect(idRead).toBeGreaterThan(0);
    expect(captured).toBeLessThan(moved);
    expect(idRead).toBeLessThan(moved);
    // Nothing after the move reads the account again.
    expect(once.slice(moved)).not.toContain('getCurrentAccountObject');
    expect(once).toContain('recordMoveOutcome({');
    expect(once).toContain('reportFromWallet(a, text, reportId)');
    expect(bg).toContain('const local = chrome.storage?.local;');
    expect(bg).not.toContain('moveFailuresReported');
  });
});
