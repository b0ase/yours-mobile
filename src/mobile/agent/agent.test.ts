import { describe, expect, test } from 'bun:test';
import { MAX_TURNS, looksLikeSecret, transcript, type AgentMessage } from './agent';
import { BWALLET_GUIDE } from './guide';

describe('transcript', () => {
  test('drops blanks and keeps the last MAX_TURNS', () => {
    const many: AgentMessage[] = Array.from({ length: MAX_TURNS + 5 }, (_, i) => ({ role: 'user', text: `m${i}` }));
    const t = transcript([{ role: 'assistant', text: '  ' }, ...many]);
    expect(t.length).toBe(MAX_TURNS);
    expect(t[0].text).toBe('m5');
  });

  test('history is capped at 8 turns (bit-sign refuses more)', () => {
    expect(MAX_TURNS).toBe(8);
    const many: AgentMessage[] = Array.from({ length: 20 }, (_, i) => ({ role: 'user', text: `m${i}` }));
    expect(transcript(many).length).toBe(8);
  });
});

describe('looksLikeSecret', () => {
  test('recovery phrases and keys are caught', () => {
    expect(looksLikeSecret('abandon '.repeat(11) + 'about')).toBe(true);
    expect(looksLikeSecret('KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn')).toBe(true);
    expect(looksLikeSecret('a'.repeat(64))).toBe(true);
  });
  test('normal questions pass', () => {
    expect(looksLikeSecret('how do I send bsv to a paymail address')).toBe(false);
    expect(looksLikeSecret('What is a ticket?')).toBe(false);
  });
});

describe('guide', () => {
  test('covers the tabs and the safety rules', () => {
    for (const w of [
      'Apps · Market · Wallet · Feed · Chat',
      'Tickets',
      'Credits',
      'bwallet.space',
      'One-click',
      'seed phrase',
    ])
      expect(BWALLET_GUIDE).toContain(w);
  });
});
