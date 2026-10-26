import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { PermissionBundler } from './permissionBundle';
import { replyError } from './userDenied';
import {
  PROMPT_BUSY_CODE,
  PROMPT_NOT_SHOWN_CODE,
  PROMPT_NOT_SHOWN_MESSAGE,
  PromptWatchdog,
  promptBusyError,
  promptNotShownError,
  rejectManagerRequest,
  withPromptNotShownCode,
  type WatchedPrompt,
} from './promptWatchdog';

const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

/** Manual clock: timers fire only when the test says so. */
const clock = () => {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (h: unknown) => void timers.delete(h as number),
    now: () => now,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
};

const setup = (opts: { pending?: () => boolean; behind?: () => boolean; busy?: boolean } = {}) => {
  const c = clock();
  const calls: string[] = [];
  const wd = new PromptWatchdog({
    isPending: opts.pending ?? (() => true),
    waitingBehindShown: opts.behind ?? (() => false),
    escalate: (p) => calls.push(`escalate ${p.requestID}`),
    fail: (p) => calls.push(`fail ${p.requestID}`),
    confirmMs: 4000,
    ...(opts.busy
      ? { failBusy: (p: WatchedPrompt) => calls.push(`busy ${p.requestID}`), busyMs: 20_000, now: () => c.now() }
      : {}),
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
  });
  return { c, calls, wd };
};

const P: WatchedPrompt = { kind: 'bundle', requestID: 'b1' };

describe('PromptWatchdog', () => {
  test('a confirmed prompt is left alone', () => {
    const { c, calls, wd } = setup();
    wd.watch(P);
    c.advance(1000);
    wd.confirm(P);
    c.advance(60_000);
    expect(calls).toEqual([]);
  });

  test('unconfirmed: opens the window at 4s, fails the request at 8s (well under the site 3 min wait)', () => {
    const { c, calls, wd } = setup();
    wd.watch(P);
    c.advance(3999);
    expect(calls).toEqual([]);
    c.advance(1);
    expect(calls).toEqual(['escalate b1']);
    c.advance(4000);
    expect(calls).toEqual(['escalate b1', 'fail b1']);
    expect(wd.watching(P)).toBe(false);
  });

  test('the window confirming after escalation saves the request', () => {
    const { c, calls, wd } = setup();
    wd.watch(P);
    c.advance(4000);
    wd.confirm(P);
    c.advance(60_000);
    expect(calls).toEqual(['escalate b1']);
  });

  test('a request answered meanwhile is dropped quietly', () => {
    let pending = true;
    const { c, calls, wd } = setup({ pending: () => pending });
    wd.watch(P);
    pending = false;
    c.advance(10_000);
    expect(calls).toEqual([]);
  });

  test('waiting its turn behind a visible sheet is never failed', () => {
    let behind = true;
    const { c, calls, wd } = setup({ behind: () => behind });
    wd.watch(P);
    c.advance(120_000);
    expect(calls).toEqual([]);
    behind = false; // the sheet in front was answered, but nothing loaded this one
    c.advance(12_000);
    expect(calls).toEqual(['escalate b1', 'fail b1']);
  });

  test('re-showing after escalation does not restart the clock (no endless retries)', () => {
    const { c, calls, wd } = setup();
    wd.watch(P);
    c.advance(4000);
    wd.watch(P);
    c.advance(4000);
    expect(calls).toEqual(['escalate b1', 'fail b1']);
  });
});

describe('the hang it fixes: a payment queued behind a dead sheet', () => {
  test('a spend joining a shown (dead) sheet only gets onUpdate: nothing new is shown', () => {
    const c = clock();
    const ready: string[] = [];
    const updated: string[] = [];
    const b = new PermissionBundler({
      onReady: (x) => ready.push(x.id),
      onUpdate: (x) => updated.push(x.id),
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
    });
    // The connect sheet opened (its window / in-page frame later vanished without an answer).
    const first = b.add({ requestID: 'r1', originator: 'tokenblaster.lol', type: 'protocol' } as never)!;
    c.advance(1000);
    expect(ready).toEqual([first.id]);
    // START: the $0.10 spend joins that sheet live. Only a reload message goes out, to a UI that is gone.
    b.add({ requestID: 'r2', originator: 'tokenblaster.lol', type: 'spending' } as never);
    c.advance(180_000);
    expect(ready).toEqual([first.id]);
    expect(updated).toEqual([first.id]);
  });

  test('a spend queued behind a frozen sheet waits until that sheet goes; dropping it shows the spend', () => {
    const c = clock();
    const ready: string[] = [];
    const b = new PermissionBundler({
      onReady: (x) => ready.push(x.id),
      setTimer: c.setTimer,
      clearTimer: c.clearTimer,
    });
    const first = b.add({ requestID: 'r1', originator: 'tokenblaster.lol', type: 'protocol' } as never)!;
    c.advance(1000);
    b.freeze(first.id);
    expect(b.add({ requestID: 'r2', originator: 'tokenblaster.lol', type: 'spending' } as never)).toBeUndefined();
    c.advance(180_000);
    expect(ready).toEqual([first.id]);
    // The watchdog's fail path drops the dead sheet: the spend gets its own sheet at once.
    b.drop(first.id);
    c.advance(1000);
    expect(ready.length).toBe(2);
  });

  test('background wires it: watch on show, confirm on payload, watch the blocking sheet when queued', () => {
    const bg = src('../background.ts');
    expect(bg).toContain("if (requestID && kind !== 'unlock') promptWatchdog.watch({ kind, requestID });");
    expect(bg).toContain('if (requestID) promptWatchdog.confirm({ kind, requestID });');
    expect(bg).toContain("if (blocking) watchPrompt({ kind: 'bundle', requestID: blocking.id });");
    expect(bg).toContain('answer(withPromptNotShownCode(withDenialCode(response)))');
    expect(bg).toContain('promptWatchdog.watch({ kind, requestID });\n    notifyPromptWindow(kind, requestID);');
  });
});

describe('the error the site sees', () => {
  test('carries ERR_PROMPT_NOT_SHOWN through the reply and the page transport', () => {
    const reply = withPromptNotShownCode({
      type: 'createAction',
      success: false,
      error: promptNotShownError().message,
    });
    expect(reply).toMatchObject({ code: PROMPT_NOT_SHOWN_CODE, error: PROMPT_NOT_SHOWN_MESSAGE, status: 503 });
    const err = replyError(reply) as Error & { code?: string };
    expect(err.message).toBe(PROMPT_NOT_SHOWN_MESSAGE);
    expect(err.code).toBe(PROMPT_NOT_SHOWN_CODE);
  });

  test('other replies are untouched', () => {
    const ok = { success: true, data: 1 };
    expect(withPromptNotShownCode(ok)).toBe(ok);
    const denied = { success: false, error: 'Permission denied.', code: 'ERR_PERMISSION_DENIED' };
    expect(withPromptNotShownCode(denied)).toBe(denied);
  });

  test('rejects the manager request with our error, not "Permission denied."', async () => {
    const got: unknown[] = [];
    const activeRequests = new Map([['r1', { pending: [{ reject: (e: unknown) => got.push(e) }] }]]);
    let denied = false;
    await rejectManagerRequest(
      { activeRequests, denyPermission: async () => void (denied = true) },
      'r1',
      promptNotShownError(),
    );
    expect((got[0] as { code: string }).code).toBe(PROMPT_NOT_SHOWN_CODE);
    expect(activeRequests.has('r1')).toBe(false);
    expect(denied).toBe(false);
    await rejectManagerRequest(
      { activeRequests, denyPermission: async () => void (denied = true) },
      'gone',
      promptNotShownError(),
    );
    expect(denied).toBe(true);
  });
});

describe('ERR_PROMPT_BUSY', () => {
  test('queued > 20 s behind a visible sheet: rejected busy (409), never approved', () => {
    const { c, calls, wd } = setup({ behind: () => true, busy: true });
    wd.watch(P);
    c.advance(19_999);
    expect(calls).toEqual([]);
    c.advance(1);
    expect(calls).toEqual(['busy b1']);
    expect(wd.watching(P)).toBe(false);
    c.advance(60_000);
    expect(calls).toEqual(['busy b1']);
  });

  test('re-watching a queued prompt does not restart its busy clock', () => {
    const { c, calls, wd } = setup({ behind: () => true, busy: true });
    wd.watch(P);
    c.advance(12_000);
    wd.watch(P);
    c.advance(12_000);
    expect(calls).toEqual(['busy b1']);
  });

  test('not behind a visible sheet: normal not-shown path, no busy', () => {
    const { c, calls, wd } = setup({ behind: () => false, busy: true });
    wd.watch(P);
    c.advance(30_000);
    expect(calls).toEqual(['escalate b1', 'fail b1']);
  });

  test('its turn comes (confirmed) before 20 s: left alone', () => {
    const { c, calls, wd } = setup({ behind: () => true, busy: true });
    wd.watch(P);
    c.advance(15_000);
    wd.confirm(P);
    c.advance(60_000);
    expect(calls).toEqual([]);
  });

  test('busy carries code 409 through a { success:false } reply', () => {
    const e = promptBusyError();
    expect(e.code).toBe(PROMPT_BUSY_CODE);
    expect(e.status).toBe(409);
    expect(withPromptNotShownCode({ success: false, error: e.message })).toMatchObject({
      code: 'ERR_PROMPT_BUSY',
      status: 409,
    });
  });
});
