import { describe, expect, test } from 'bun:test';
import { pickScroller, retapAction, scrollBehavior } from './tabRetap';

const box = (o: Partial<Parameters<typeof pickScroller>[0][number]> = {}) => ({
  scrollTop: 0,
  scrollHeight: 2000,
  clientHeight: 700,
  overflowY: 'auto',
  shown: true,
  ...o,
});

describe('tab re-tap', () => {
  test('scrolled down goes to the top; at the top it refreshes', () => {
    expect(retapAction(420)).toBe('top');
    expect(retapAction(0)).toBe('refresh');
    expect(retapAction(1)).toBe('refresh');
  });

  test('reduced motion jumps instead of smooth scrolling', () => {
    expect(scrollBehavior(true)).toBe('auto');
    expect(scrollBehavior(false)).toBe('smooth');
  });

  test('picks the scrolled list, ignoring hidden, non-scrolling and overflow-visible elements', () => {
    expect(pickScroller([])).toBe(-1);
    expect(
      pickScroller([
        box({ overflowY: 'visible', scrollTop: 900 }),
        box({ shown: false, scrollTop: 800 }),
        box({ scrollHeight: 700 }),
        box({ scrollTop: 300 }),
        box({ scrollTop: 50 }),
      ]),
    ).toBe(3);
    // Nothing scrolled yet: the tallest viewport (the page, not a small inner strip).
    expect(pickScroller([box({ clientHeight: 120, scrollHeight: 400 }), box()])).toBe(1);
  });
});
