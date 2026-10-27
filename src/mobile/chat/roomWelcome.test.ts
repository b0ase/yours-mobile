import { describe, expect, it } from 'bun:test';
import { AGREEMENT_DRAFT, dismissWelcome, shouldShowWelcome, welcomeDismissed } from './roomWelcome';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("b's welcome card (ported from bChatX #465)", () => {
  const base = { ticker: 'ROOM1', empty: true, dm: false, special: false };
  it('shows in a new, empty room', () => expect(shouldShowWelcome(base, mem())).toBe(true));
  it('not once there are messages, in a 1:1, or in official rooms', () => {
    const s = mem();
    expect(shouldShowWelcome({ ...base, empty: false }, s)).toBe(false);
    expect(shouldShowWelcome({ ...base, dm: true }, s)).toBe(false);
    expect(shouldShowWelcome({ ...base, special: true }, s)).toBe(false);
  });
  it('"Just chat" hides it for that room only, case-insensitively', () => {
    const s = mem();
    dismissWelcome('room1', s);
    expect(welcomeDismissed('ROOM1', s)).toBe(true);
    expect(shouldShowWelcome(base, s)).toBe(false);
    expect(shouldShowWelcome({ ...base, ticker: 'ROOM2' }, s)).toBe(true);
  });
  it('survives storage that throws', () => {
    const bad = {
      getItem: () => {
        throw new Error('x');
      },
      setItem: () => {
        throw new Error('x');
      },
    };
    expect(() => dismissWelcome('R', bad)).not.toThrow();
    expect(shouldShowWelcome(base, bad)).toBe(true);
  });
  it('the agreement button only drafts, via b', () => expect(AGREEMENT_DRAFT.startsWith('/b ')).toBe(true));
});
