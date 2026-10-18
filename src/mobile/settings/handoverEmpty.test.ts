import { describe, expect, test } from 'bun:test';
import { handoverIsEmpty } from './handoverEmpty';

describe('Name handover card', () => {
  test('a new wallet with no names, offers or message shows no card', () => {
    expect(handoverIsEmpty(0, 0, '')).toBe(true);
  });
  test('shows when there is a name, an offer or a message', () => {
    expect(handoverIsEmpty(1, 0, '')).toBe(false);
    expect(handoverIsEmpty(0, 1, '')).toBe(false);
    expect(handoverIsEmpty(0, 0, 'x is yours.')).toBe(false);
  });
});
