import { describe, expect, test } from 'bun:test';
import { forwardCwiCall, RELOAD_PAGE_ERROR, type ForwardRuntime } from './cwiForward';

const collect = () => {
  const got: unknown[] = [];
  return { got, answer: (d: unknown) => got.push(d) };
};

describe('forwardCwiCall', () => {
  test('passes the background answer through', () => {
    const { got, answer } = collect();
    const rt: ForwardRuntime = { id: 'x', sendMessage: (_m, cb) => cb({ success: true, data: 1 }) };
    forwardCwiCall(rt, { action: 'getPublicKey' }, answer);
    expect(got).toEqual([{ success: true, data: 1 }]);
  });

  test('a closed channel (worker restarted mid-call) answers with an error', () => {
    const { got, answer } = collect();
    const rt: ForwardRuntime = {
      id: 'x',
      lastError: null,
      sendMessage: (_m, cb) => {
        rt.lastError = { message: 'The message port closed before a response was received.' };
        cb(undefined);
      },
    };
    forwardCwiCall(rt, {}, answer);
    expect(got).toEqual([{ success: false, error: 'The message port closed before a response was received.' }]);
  });

  test('extension reloaded: sendMessage throws, the page still gets an answer', () => {
    const { got, answer } = collect();
    const rt: ForwardRuntime = {
      id: 'x',
      sendMessage: () => {
        throw new Error('Extension context invalidated.');
      },
    };
    expect(() => forwardCwiCall(rt, {}, answer)).not.toThrow();
    expect(got).toEqual([{ success: false, error: RELOAD_PAGE_ERROR }]);
  });

  test('runtime gone (id undefined) answers without calling sendMessage', () => {
    const { got, answer } = collect();
    let called = false;
    forwardCwiCall({ sendMessage: () => (called = true) }, {}, answer);
    forwardCwiCall(undefined, {}, answer);
    expect(called).toBe(false);
    expect(got).toEqual([
      { success: false, error: RELOAD_PAGE_ERROR },
      { success: false, error: RELOAD_PAGE_ERROR },
    ]);
  });

  test('answers once even if the callback fires after a throw', () => {
    const { got, answer } = collect();
    const rt: ForwardRuntime = {
      id: 'x',
      sendMessage: (_m, cb) => {
        cb({ success: true });
        throw new Error('late');
      },
    };
    forwardCwiCall(rt, {}, answer);
    expect(got).toEqual([{ success: true }]);
  });
});

describe('BRC-219 liveness: one port per call, open exactly while the page waits', () => {
  const live = () => {
    const ports: { name: string; posted: unknown[]; disconnected: boolean }[] = [];
    let reply: ((r: unknown) => void) | undefined;
    const sent: Record<string, unknown>[] = [];
    const rt: ForwardRuntime = {
      id: 'x',
      sendMessage: (m, cb) => {
        sent.push(m as Record<string, unknown>);
        reply = cb;
      },
      connect: ({ name }) => {
        const p = { name, posted: [] as unknown[], disconnected: false };
        ports.push(p);
        return { postMessage: (x: unknown) => p.posted.push(x), disconnect: () => (p.disconnected = true) };
      },
    };
    return { rt, ports, sent, answerNow: (r: unknown) => reply!(r) };
  };

  test('the call names its port; a single-page route change touches neither; the answer closes the port', () => {
    const l = live();
    const { got, answer } = collect();
    forwardCwiCall(l.rt, { action: 'createAction', params: {}, originator: 'game.example' }, answer, 'tok-1');
    expect(l.ports).toHaveLength(1);
    expect(l.ports[0]).toMatchObject({ name: 'bwx-live', posted: [{ token: 'tok-1' }], disconnected: false });
    expect(l.sent[0]).toMatchObject({ action: 'createAction', liveToken: 'tok-1' });
    // history.pushState / hash change: the content script's document is the same, so nothing happens here and
    // the port stays open (only Chrome closes it, when the document itself goes away).
    (globalThis as { history?: History }).history?.pushState?.({}, '', '#/next-route');
    expect(l.ports[0].disconnected).toBe(false);
    expect(got).toEqual([]);
    l.answerNow({ success: true, data: { txid: 'ab' } });
    expect(got).toEqual([{ success: true, data: { txid: 'ab' } }]);
    expect(l.ports[0].disconnected).toBe(true);
    // A runtime without connect still forwards the call, as before, just without a token.
    const old = collect();
    forwardCwiCall(
      { id: 'x', sendMessage: (m, cb) => cb({ success: true, data: m }) },
      { action: 'getPublicKey' },
      old.answer,
    );
    expect(old.got).toEqual([{ success: true, data: { action: 'getPublicKey' } }]);
  });
});
