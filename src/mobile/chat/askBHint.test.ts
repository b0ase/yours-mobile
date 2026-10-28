import { describe, expect, test } from 'bun:test';
import { mentionsDollarB, showPublicBHint, toPrivateB, PUBLIC_B_HINT, PRIVATE_B_ACTION } from './askBHint';

describe('$b public hint (parity with bit-sign ask-b-modal)', () => {
  test('$b as its own word', () => {
    expect(mentionsDollarB('hey $b what now?')).toBe(true);
    expect(mentionsDollarB('$b')).toBe(true);
    expect(mentionsDollarB('$b.bot hi')).toBe(true);
    expect(mentionsDollarB('$bob hi')).toBe(false);
    expect(mentionsDollarB('$bwalletx')).toBe(false);
    expect(mentionsDollarB('/b hi')).toBe(false);
  });
  test('hint only when others are in the room', () => {
    expect(showPublicBHint('$b hi', 2)).toBe(true);
    expect(showPublicBHint('$b hi', 1)).toBe(false);
    expect(showPublicBHint('$b hi', 0)).toBe(false);
    expect(showPublicBHint('hello', 5)).toBe(false);
  });
  test('ask privately turns the draft into /b', () => {
    expect(toPrivateB('hey $b what now?')).toBe('/b hey what now?');
    expect(toPrivateB('$b')).toBe('/b ');
  });
  test('plain copy', () => {
    expect(PUBLIC_B_HINT).toBe('b will answer in front of everyone in this room');
    expect(PRIVATE_B_ACTION).toBe('Ask privately instead');
  });
});

describe('wide chat empty pane is Ask b', () => {
  test('the same AgentPage as /m/ask-b, with the room hint', async () => {
    const src = await Bun.file(new URL('../wide/WideShell.tsx', import.meta.url)).text();
    expect(src).toContain('<AgentConversation starters={PANE_STARTERS}');
    expect(src).toContain('data-ask-b-pane');
    expect(src).toContain('or pick a room on the left');
  });
});

import { PANE_STARTERS, PANE_GREETING } from './askBHint';
describe('pane starters', () => {
  test('greeting and four starters', () => {
    expect(PANE_GREETING).toBe('What do you want to do?');
    expect(PANE_STARTERS.map((o) => o.label)).toEqual([
      'What do you want to do?',
      'Start a room with someone',
      'Find a room to join',
      'Catch me up on my rooms',
      'Draft a contract or offer in a room',
    ]);
    expect(PANE_STARTERS[3].prompt).toMatch(/unread.*mentions.*signature/);
  });
});
