import { describe, expect, test } from 'bun:test';
import { clearHelpDeskUnpin, helpDeskUnpinned, HELP_DESK_UNPIN_KEY, setHelpDeskUnpinned } from './helpDeskPin';

const mem = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    m,
  };
};

describe('bWallet Help Desk pin (per device)', () => {
  test('pinned by default', () => {
    expect(helpDeskUnpinned(mem())).toBe(false);
  });
  test('unpin is stored locally; pin again clears it', () => {
    const s = mem();
    setHelpDeskUnpinned(true, s);
    expect(s.m.get(HELP_DESK_UNPIN_KEY)).toBe('1');
    expect(helpDeskUnpinned(s)).toBe(true);
    setHelpDeskUnpinned(false, s);
    expect(helpDeskUnpinned(s)).toBe(false);
  });
  test('reset / restore pins it again', () => {
    const s = mem();
    setHelpDeskUnpinned(true, s);
    clearHelpDeskUnpin(s);
    expect(helpDeskUnpinned(s)).toBe(false);
  });
  test('no storage: stays pinned', () => {
    expect(helpDeskUnpinned(null)).toBe(false);
  });
});
