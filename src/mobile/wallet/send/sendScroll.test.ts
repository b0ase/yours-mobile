import { describe, expect, test } from 'bun:test';
import { scrollCentered, sendFocusField, shouldRevealButton, type ScrollEnv } from './sendScroll';

const fakeEnv = (withViewport = true) => {
  const frames: (() => void)[] = [];
  const timers: (() => void)[] = [];
  const listeners = new Set<() => void>();
  const env: ScrollEnv = {
    raf: (cb) => frames.push(cb),
    viewport: withViewport
      ? {
          addEventListener: ((_: string, cb: () => void) => listeners.add(cb)) as never,
          removeEventListener: ((_: string, cb: () => void) => listeners.delete(cb)) as never,
        }
      : null,
    setTimeout: (cb) => timers.push(cb),
    clearTimeout: () => {},
  };
  return { env, frames, timers, listeners, resize: () => [...listeners].forEach((l) => l()) };
};

const fakeEl = () => {
  const calls: unknown[] = [];
  return { calls, el: { scrollIntoView: (o?: unknown) => calls.push(o) } as unknown as HTMLElement };
};

describe('scrollCentered', () => {
  test('scrolls to centre after layout, not synchronously', () => {
    const f = fakeEnv();
    const { el, calls } = fakeEl();
    scrollCentered(el, f.env);
    expect(calls.length).toBe(0);
    f.frames.forEach((c) => c());
    expect(calls).toEqual([{ block: 'center', behavior: 'smooth' }]);
  });

  test('scrolls again once when the keyboard resizes the visual viewport', () => {
    const f = fakeEnv();
    const { el, calls } = fakeEl();
    scrollCentered(el, f.env);
    f.frames.forEach((c) => c());
    f.resize();
    f.resize();
    expect(calls.length).toBe(2);
    expect(f.listeners.size).toBe(0);
  });

  test('stops listening after the wait and on cancel', () => {
    const f = fakeEnv();
    const { el } = fakeEl();
    scrollCentered(el, f.env);
    f.timers.forEach((c) => c());
    expect(f.listeners.size).toBe(0);
    const g = fakeEnv();
    const cancel = scrollCentered(el, g.env);
    cancel();
    expect(g.listeners.size).toBe(0);
  });

  test('no element or no visualViewport is safe', () => {
    expect(() => scrollCentered(null)()).not.toThrow();
    const f = fakeEnv(false);
    const { el, calls } = fakeEl();
    scrollCentered(el, f.env)();
    f.frames.forEach((c) => c());
    expect(calls.length).toBe(1);
  });

  test('falls back to plain scrollIntoView when options throw', () => {
    const f = fakeEnv(false);
    const calls: unknown[] = [];
    const el = {
      scrollIntoView: (o?: unknown) => {
        if (o) throw new Error('old webview');
        calls.push('plain');
      },
    } as unknown as HTMLElement;
    scrollCentered(el, f.env);
    f.frames.forEach((c) => c());
    expect(calls).toEqual(['plain']);
  });
});

describe('sendFocusField', () => {
  test('recipient first, amount when prefilled', () => {
    expect(sendFocusField([{ address: '' }])).toBe('address');
    expect(sendFocusField([{ address: '  ' }])).toBe('address');
    expect(sendFocusField([{ address: '$bug' }])).toBe('amount');
    expect(sendFocusField([])).toBe('address');
  });
});

describe('shouldRevealButton', () => {
  test('only when the amount first becomes non-zero', () => {
    expect(shouldRevealButton(0, 1000)).toBe(true);
    expect(shouldRevealButton(1000, 2000)).toBe(false);
    expect(shouldRevealButton(1000, 0)).toBe(false);
    expect(shouldRevealButton(0, 0)).toBe(false);
  });
});
