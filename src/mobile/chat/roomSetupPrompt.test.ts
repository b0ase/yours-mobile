import { describe, expect, it } from 'bun:test';
import { rememberRoomSetup, roomSetupState, shouldOfferRoomSetup } from './roomSetupPrompt';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('room set-up prompt', () => {
  it('offers once per token room, then remembers the choice', () => {
    const s = mem();
    expect(shouldOfferRoomSetup('VEXVOID', true, s)).toBe(true);
    rememberRoomSetup('VEXVOID', 'later', s);
    expect(roomSetupState('vexvoid', s)).toBe('later');
    expect(shouldOfferRoomSetup('VEXVOID', true, s)).toBe(false);
  });
  it('never offers for open rooms or without storage', () => {
    expect(shouldOfferRoomSetup('stuff', false, mem())).toBe(false);
    expect(roomSetupState('x', null)).toBe(null);
  });
});
