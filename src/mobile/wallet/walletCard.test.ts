import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { cardSats, memberSince, shortAddr } from './walletCardText';

describe('wallet card text', () => {
  test('sats and member since', () => {
    expect(cardSats(1234567)).toBe('1,234,567 sats');
    expect(memberSince(undefined)).toBe('');
    expect(memberSince(new Date(2026, 9, 2).getTime())).toBe('10/26');
    expect(shortAddr('1234567890abcdefghij')).toBe('123456…efghij');
  });

  test('never looks like a payment card', () => {
    const src = readFileSync(join(import.meta.dir, 'WalletCard.tsx'), 'utf8').toLowerCase();
    for (const w of ['credit', 'debit', 'visa', 'mastercard', 'cvc', 'cvv', 'expir', 'valid thru']) {
      expect(src).not.toContain(w);
    }
  });
});
