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
