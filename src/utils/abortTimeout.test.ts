/**
 * anySignal (the iOS 15 AbortSignal.any polyfill) removes its listeners from every input once it has aborted
 * (06c re-check f66d8ccf, P1): the libraries combine a caller's long-lived options.signal with a per-request timeout,
 * so without the cleanup that long-lived signal collected one listener per request.
 */
import { describe, expect, test } from 'bun:test';
import { anySignal } from './abortTimeout';

/** Count the listeners currently attached to a signal through addEventListener / removeEventListener. */
const tracked = (signal: AbortSignal) => {
  const live = new Set<unknown>();
  let adds = 0;
  const add = signal.addEventListener.bind(signal);
  const rem = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    if (type === 'abort') {
      adds++;
      live.add(fn);
    }
    return add(type, fn, opts as AddEventListenerOptions);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
    if (type === 'abort') live.delete(fn);
    return rem(type, fn, opts as EventListenerOptions);
  }) as typeof signal.removeEventListener;
  return { adds: () => adds, live: () => live.size };
};

describe('anySignal: listeners are removed once it aborts', () => {
  test('100 combinations with one long-lived signal leave no listener on it', () => {
    const long = new AbortController().signal;
    const t = tracked(long);
    for (let i = 0; i < 100; i++) {
      const short = new AbortController();
      const s = anySignal([long, short.signal]);
      expect(t.live()).toBe(1);
      short.abort('done');
      expect(s.aborted).toBe(true);
      expect(s.reason).toBe('done');
      expect(t.live()).toBe(0);
    }
    expect(t.adds()).toBe(100);
    expect(long.aborted).toBe(false);
  });

  test('the first input to abort detaches every input, and its reason wins', () => {
    const a = new AbortController();
    const b = new AbortController();
    const c = new AbortController();
    const ta = tracked(a.signal);
    const tb = tracked(b.signal);
    const tc = tracked(c.signal);
    const s = anySignal([a.signal, b.signal, c.signal]);
    expect([ta.live(), tb.live(), tc.live()]).toEqual([1, 1, 1]);
    b.abort('b-first');
    expect(s.aborted).toBe(true);
    expect(s.reason).toBe('b-first');
    expect([ta.live(), tb.live(), tc.live()]).toEqual([0, 0, 0]);
    a.abort('a-later');
    c.abort('c-later');
    expect(s.reason).toBe('b-first');
  });

  test('an input that is already aborted gives an aborted signal at once and adds no listener', () => {
    const live = new AbortController();
    const t = tracked(live.signal);
    const pre = new AbortController();
    pre.abort('already');
    const s = anySignal([live.signal, pre.signal]);
    expect(s.aborted).toBe(true);
    expect(s.reason).toBe('already');
    expect(t.adds()).toBe(0);
  });

  test('a timeout combined with a long-lived signal detaches from it when the timeout fires', async () => {
    const long = new AbortController().signal;
    const t = tracked(long);
    const timer = new AbortController();
    setTimeout(() => timer.abort(new Error('timeout')), 5);
    const s = anySignal([long, timer.signal]);
    expect(t.live()).toBe(1);
    await new Promise((r) => setTimeout(r, 25));
    expect(s.aborted).toBe(true);
    expect((s.reason as Error).message).toBe('timeout');
    expect(t.live()).toBe(0);
  });

  test('takes any iterable of signals, as the native AbortSignal.any does', () => {
    const a = new AbortController();
    const b = new AbortController();
    const s = anySignal(new Set([a.signal, b.signal]));
    expect(s.aborted).toBe(false);
    a.abort('from-set');
    expect(s.reason).toBe('from-set');
  });

  test('no inputs: never aborts', () => {
    expect(anySignal([]).aborted).toBe(false);
  });
});
