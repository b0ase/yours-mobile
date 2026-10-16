import { describe, expect, test } from 'bun:test';
import { payeeDetail, recipientHint } from './payeeText';

const short = (s: string) => (s.length > 22 ? `${s.slice(0, 10)}…${s.slice(-8)}` : s);

describe('recipientHint', () => {
  test('names our paymail domain as a hint, never a bare app name', () => {
    expect(recipientHint('bwalletx.com')).toBe('$name, name@bwalletx.com, paymail or address');
    expect(recipientHint('')).toBe('$name, paymail or address');
  });
});

describe('payeeDetail', () => {
  test('shows the full paymail next to the $name', () => {
    expect(payeeDetail('$mike', 'mike@bwalletx.com', short)).toBe('$mike · mike@bwalletx.com');
  });
  test('a typed paymail is not repeated', () => {
    expect(payeeDetail('mike@bwalletx.com', 'mike@bwalletx.com', short)).toBe('mike@bwalletx.com');
  });
  test('shortens a long address', () => {
    expect(payeeDetail('alice.opns', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', short)).toBe(
      'alice.opns · 1A1zP1eP5Q…v7DivfNa',
    );
  });
});
