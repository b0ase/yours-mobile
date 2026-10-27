import { describe, expect, it } from 'bun:test';
import { chatName, chatShortName } from './chatName';

describe('Ask b chat names (ported from bChatX #471)', () => {
  const id = 'd3f117ca-9870-43f3-bc14-c1bf32d3a3c8';
  const n = chatName(id, '$b0asex');
  it('is app-handle-word-word-nn', () => expect(n).toMatch(/^bwalletx-b0asex-[a-z]+-[a-z]+-\d{2}$/));
  it('is stable for the same chat', () => {
    expect(chatName(id, 'b0asex')).toBe(n);
    expect(chatName(id.toUpperCase(), 'B0ASEX')).toBe(n);
  });
  it('matches bChatX for the same id (same words and hash)', () =>
    expect(chatName(id, 'b0asex', 'bchatx').replace(/^bchatx-/, 'bwalletx-')).toBe(n));
  it('a scope replaces the app', () => expect(chatName(id, 'b0asex', 'bWriter')).toStartWith('bwriter-b0asex-'));
  it('names it without a handle', () => expect(chatName(id, null)).toMatch(/^bwalletx-[a-z]+-[a-z]+-\d{2}$/));
  it('short name is the memorable part', () => {
    expect(chatShortName(id)).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
    expect(n.endsWith(chatShortName(id))).toBe(true);
  });
  it('500 chats get (almost all) different names', () => {
    const many = new Set(
      Array.from({ length: 500 }, (_, i) => chatShortName(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)),
    );
    expect(many.size).toBeGreaterThanOrEqual(490);
  });
});
