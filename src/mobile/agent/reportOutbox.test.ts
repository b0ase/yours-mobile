import { describe, expect, test } from 'bun:test';
import {
  DEVICE,
  OUTBOX_CAP,
  backoffMs,
  enqueueReport,
  failureReason,
  flushOutbox,
  newReportId,
  OUTBOX_MAX_AUTO_TRIES,
  outboxText,
  queuedFor,
  readOutbox,
  reportMessageId,
  resetBackoff,
  runnerMaySend,
} from './reportOutbox';
import { parseReport } from './paid';

const memStore = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const call = async () => ({});

const NUMBERED = 'abandon ability able about above absent absorb abstract absurd abuse access accident'
  .split(' ')
  .map((w, i) => `${i + 1}. ${w}`)
  .join('\n');

describe('report outbox', () => {
  test('a numbered recovery phrase is never stored', () => {
    const store = memStore();
    enqueueReport('A', `help, my words are\n${NUMBERED}`, 'signin', store, 0);
    const raw = store.getItem('bwallet.agent.reportOutbox') ?? '';
    expect(raw).not.toContain('abandon');
    expect(raw).not.toContain('accident');
  });
  test('items queued by an older build are scrubbed before they are sent', async () => {
    const store = memStore();
    store.setItem(
      'bwallet.agent.reportOutbox',
      JSON.stringify([{ id: 'x', account: 'A', text: NUMBERED, at: 0, tries: 1, nextAt: 0, reason: 'signin' }]),
    );
    const seen: string[] = [];
    await flushOutbox('A', call, {
      store,
      now: () => 1000,
      send: async (_c, text) => {
        seen.push(text);
        throw Object.assign(new Error('no'), { status: 401 });
      },
    });
    expect(seen).toEqual(['[recovery words hidden]']);
    expect(store.getItem('bwallet.agent.reportOutbox')).not.toContain('abandon');
  });
  test('a failed report is kept, per account', () => {
    const store = memStore();
    enqueueReport('A', 'broke', 'offline', store, 1000);
    enqueueReport('B', 'other', 'error', store, 1000);
    expect(queuedFor('A', store, 2000).map((r) => r.text)).toEqual(['broke']);
    expect(queuedFor('B', store, 2000).map((r) => r.text)).toEqual(['other']);
  });
  test('reports with no account open show for any account', () => {
    const store = memStore();
    const r = enqueueReport(null, 'boot', 'signin', store, 1000);
    expect(r.account).toBe(DEVICE);
    expect(queuedFor('A', store, 2000).length).toBe(1);
  });
  test('capped per account, oldest dropped', () => {
    const store = memStore();
    for (let i = 0; i < OUTBOX_CAP + 5; i++) enqueueReport('A', `r${i}`, 'error', store, 1000 + i);
    enqueueReport('B', 'keep', 'error', store, 1000);
    const a = queuedFor('A', store, 5000).filter((r) => r.account === 'A');
    expect(a.length).toBe(OUTBOX_CAP);
    expect(a[0].text).toBe('r5');
    expect(queuedFor('B', store, 5000).length).toBe(1);
  });
  test('backoff grows and is capped', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(50)).toBe(60 * 60_000);
  });
  test('failure reasons', () => {
    expect(failureReason(new Error('x'), false)).toBe('offline');
    expect(failureReason(new TypeError('Failed to fetch'), true)).toBe('offline');
    expect(failureReason(Object.assign(new Error('no'), { status: 401 }), true)).toBe('signin');
    expect(failureReason(new Error('Wallet is locked.'), true)).toBe('signin');
    expect(failureReason(new Error('500'), true)).toBe('error');
  });
  test('flush sends due reports and removes only those that were sent', async () => {
    const store = memStore();
    enqueueReport('A', 'one', 'offline', store, 0);
    enqueueReport('A', 'two', 'offline', store, 0);
    const seen: string[] = [];
    const r = await flushOutbox('A', call, {
      store,
      now: () => 10 * 60_000,
      send: async (_c, text) => {
        seen.push(text);
        if (text === 'two') throw new Error('500');
        return { ack: 'ok', ref: 'F-1' };
      },
    });
    expect(seen).toEqual(['one', 'two']);
    expect(r).toEqual({ sent: 1, left: 1 });
    const left = readOutbox(store, 10 * 60_000);
    expect(left.map((x) => x.text)).toEqual(['two']);
    expect(left[0].tries).toBe(2);
    expect(left[0].nextAt).toBe(10 * 60_000 + backoffMs(2));
  });
  test('respects backoff unless forced', async () => {
    const store = memStore();
    enqueueReport('A', 'one', 'offline', store, 0);
    let sends = 0;
    const send = async () => {
      sends++;
      return { ack: 'ok', ref: '' };
    };
    await flushOutbox('A', call, { store, now: () => 1000, send });
    expect(sends).toBe(0);
    await flushOutbox('A', call, { store, now: () => 1000, send, force: true });
    expect(sends).toBe(1);
    expect(readOutbox(store, 1000)).toEqual([]);
  });
  test('stops at the first offline / sign-in failure and never drops', async () => {
    const store = memStore();
    enqueueReport('A', 'one', 'offline', store, 0);
    enqueueReport('A', 'two', 'offline', store, 0);
    let sends = 0;
    await flushOutbox('A', call, {
      store,
      force: true,
      now: () => 1000,
      send: async () => {
        sends++;
        throw Object.assign(new Error('unauthorised'), { status: 401 });
      },
    });
    expect(sends).toBe(1);
    const left = readOutbox(store, 1000);
    expect(left.length).toBe(2);
    expect(left[0].reason).toBe('signin');
  });
});

describe('failureReason: offline even when navigator says online', () => {
  test('aborts, timeouts and DNS failures read as offline', () => {
    expect(failureReason(new Error('signal is aborted without reason'), true)).toBe('offline');
    expect(failureReason(new DOMException('x', 'TimeoutError'), true)).toBe('offline');
    expect(failureReason('net::ERR_NAME_NOT_RESOLVED', true)).toBe('offline');
  });
  test('a server error is still an error, sign-in still sign-in', () => {
    expect(failureReason(new Error('HTTP 500'), true)).toBe('error');
    expect(failureReason(Object.assign(new Error('x'), { status: 401 }), true)).toBe('signin');
  });
  test("offline text says You're offline", () => expect(outboxText('offline').startsWith("You're offline")).toBe(true));
});

describe('acknowledged reports leave the outbox; resends carry one message_id (5.2.62)', () => {
  test("bit-sign's reply for a question (ok, empty ack) drops the item: no resend on the next open", async () => {
    const store = memStore();
    for (const t of ['r1', 'r2', 'r3', 'r4']) enqueueReport('A', t, 'error', store, 0);
    let posts = 0;
    // The real parser over the route's real reply: { ok: true, id, ref, ack: '' } (b-feedback-rules ackText).
    const send = async () => parseReport({ ok: true, id: 400 + ++posts, ref: `#F-${400 + posts}`, ack: '' });
    expect(await flushOutbox('A', call, { store, force: true, now: () => 1000, send })).toEqual({ sent: 4, left: 0 });
    // Ten more opens: nothing left to send.
    for (let i = 0; i < 10; i++) await flushOutbox('A', call, { store, force: true, now: () => 2000 + i, send });
    expect(posts).toBe(4);
  });

  test('a reply that says it was not logged (ok: false) stays queued with a backoff', async () => {
    const store = memStore();
    enqueueReport('A', 'one', 'error', store, 0);
    const r = await flushOutbox('A', call, {
      store,
      force: true,
      now: () => 1000,
      send: async () => parseReport({ ok: false, ack: "I couldn't log that just now." }),
    });
    expect(r).toEqual({ sent: 0, left: 1 });
    const [left] = readOutbox(store, 1000);
    expect(left.reason).toBe('error');
    expect(left.nextAt).toBe(1000 + backoffMs(2));
  });

  test('every send of one report carries the same message_id; the first send can name it', async () => {
    const store = memStore();
    const queued = enqueueReport('A', 'one', 'offline', store, 0, 'firstsend-id');
    expect(queued.id).toBe('firstsend-id');
    const ids: string[] = [];
    const send = async (_c: unknown, _t: string, messageId: string) => {
      ids.push(messageId);
      if (ids.length < 3) throw new Error('500');
      return { ok: true, ack: 'Noted.' };
    };
    for (let i = 0; i < 3; i++) await flushOutbox('A', call, { store, force: true, now: () => 1000 + i, send });
    expect(ids).toEqual(Array(3).fill(reportMessageId('firstsend-id')));
    expect(readOutbox(store, 2000)).toEqual([]);
  });

  test('report ids are unique enough to dedupe on', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newReportId(0)));
    expect(ids.size).toBe(1000);
    expect(newReportId(0)).toMatch(/^0-[0-9a-f]{16}$/);
    expect(reportMessageId('x')).toBe('bwx-report:x');
  });
});

describe('automatic sends wait for the backoff and stop after a cap; only Retry forces (review of #557, L6)', () => {
  test('opening the app again and again sends a failing report only when its backoff is up', async () => {
    const store = memStore();
    enqueueReport('A', 'one', 'error', store, 0);
    let posts = 0;
    const send = async () => {
      posts++;
      throw new Error('500');
    };
    // Twenty opens in the first minute: one send (when its 30 s were up).
    for (let i = 0; i < 20; i++) await flushOutbox('A', call, { store, now: () => 31_000 + i * 1000, send });
    expect(posts).toBe(1);
  });

  test(`after ${OUTBOX_MAX_AUTO_TRIES} automatic tries it waits for the person's Retry`, async () => {
    const store = memStore();
    enqueueReport('A', 'one', 'error', store, 0);
    let posts = 0;
    const send = async () => {
      posts++;
      throw new Error('500');
    };
    let t = 0;
    for (let i = 0; i < 40; i++) {
      t += 2 * 60 * 60_000; // always past the backoff
      await flushOutbox('A', call, { store, now: () => t, send });
    }
    expect(posts).toBe(OUTBOX_MAX_AUTO_TRIES);
    expect(readOutbox(store, t).length).toBe(1);
    await flushOutbox('A', call, { store, now: () => t, send, force: true });
    expect(posts).toBe(OUTBOX_MAX_AUTO_TRIES + 1);
  });

  test('the background runner never forces; Retry does', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./reportSend.tsx', import.meta.url), 'utf8');
    const runner = src.slice(src.indexOf('export const ReportOutboxRunner'));
    expect(runner).toContain('flushOutbox(account, call)');
    expect(runner).not.toContain('force');
    expect(src).toMatch(/retryOutbox[\s\S]*?flushOutbox\(account, agentCaller\(apiContext\), \{ force: true \}\)/);
  });

  test('the same report id is queued once', () => {
    const store = memStore();
    enqueueReport('A', 'move failed', 'error', store, 0, 'k-1');
    enqueueReport('A', 'move failed', 'error', store, 5, 'k-1');
    expect(readOutbox(store, 10).map((r) => r.id)).toEqual(['k-1']);
  });
});

test("Ask b's tellTeam queues a reply that wasn't logged (ok: false), with its id, as reportSend does (L1)", async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./AgentConversation.tsx', import.meta.url), 'utf8');
  const tell = src.slice(src.indexOf('const tellTeam'), src.indexOf('const runFree'));
  expect(tell).toContain('if (r.ok) return r;');
  expect(tell).toContain("enqueueReport(accountId, text, 'error', undefined, undefined, id);");
});

describe('only real errors count toward the cap; sign-in and coming back online make waiting reports due (N3)', () => {
  test('offline and signed-out failures never use up the automatic tries', async () => {
    const store = memStore();
    enqueueReport('A', 'one', 'offline', store, 0);
    let t = 0;
    let posts = 0;
    const offline = async () => {
      posts++;
      throw new TypeError('Failed to fetch');
    };
    for (let i = 0; i < 30; i++) {
      t += 2 * 60 * 60_000;
      await flushOutbox('A', call, { store, now: () => t, send: offline });
    }
    expect(posts).toBe(30);
    expect(readOutbox(store, t)[0].errors).toBe(0);
    // Back online, a server error: those count, up to the cap.
    const broken = async () => {
      posts++;
      throw new Error('500');
    };
    for (let i = 0; i < 30; i++) {
      t += 2 * 60 * 60_000;
      await flushOutbox('A', call, { store, now: () => t, send: broken });
    }
    expect(posts).toBe(30 + OUTBOX_MAX_AUTO_TRIES);
  });

  test('resetBackoff: the waiting reports of that cause are due now, the others keep their wait', () => {
    const store = memStore();
    enqueueReport('A', 'offline one', 'offline', store, 0);
    enqueueReport('A', 'signin one', 'signin', store, 0);
    enqueueReport('B', 'other account', 'offline', store, 0);
    expect(resetBackoff('A', 'offline', store, 1000)).toBe(1);
    const byText = Object.fromEntries(readOutbox(store, 1000).map((r) => [r.text, r]));
    expect(byText['offline one'].nextAt).toBe(0);
    expect(byText['offline one'].tries).toBe(1);
    expect(byText['signin one'].nextAt).toBeGreaterThan(0);
    expect(byText['other account'].nextAt).toBeGreaterThan(0);
    expect(resetBackoff('A', 'signin', store, 1000)).toBe(1);
  });

  test('the runner resets on sign-in (bChatX session event) and on coming back online', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./reportSend.tsx', import.meta.url), 'utf8');
    expect(src).toContain("resetBackoff(account, 'offline');");
    expect(src).toContain("resetBackoff(account, 'signin');");
    expect(src).toContain('window.addEventListener(SESSION_EVENT, onSession);');
    expect(src).toContain('window.removeEventListener(SESSION_EVENT, onSession);');
  });
});

describe("the runner never sends one account's reports under another's bChatX handle (round 3)", () => {
  test("mid-switch (bChatX already on B, the page still on A): A's reports wait", () => {
    const base = { account: 'A', queued: 4, online: true };
    expect(runnerMaySend({ ...base, chatAccount: 'A' })).toBe(true);
    expect(runnerMaySend({ ...base, chatAccount: 'B' })).toBe(false);
    expect(runnerMaySend({ ...base, chatAccount: null })).toBe(false);
    expect(runnerMaySend({ ...base, chatAccount: 'A', online: false })).toBe(false);
    expect(runnerMaySend({ ...base, chatAccount: 'A', queued: 0 })).toBe(false);
    // No account open and no bChatX account: the device's own reports may go.
    expect(runnerMaySend({ account: null, chatAccount: null, queued: 1, online: true })).toBe(true);
  });

  test('wired: every run checks the bChatX account first', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./reportSend.tsx', import.meta.url), 'utf8');
    const run = src.slice(src.indexOf('const run = () => {'), src.indexOf('const onVisible'));
    expect(run).toContain('chatAccount: getChatAccount(),');
    expect(run.indexOf('runnerMaySend(')).toBeLessThan(run.indexOf('flushOutbox('));
  });
});
