import { describe, expect, test } from 'bun:test';
import {
  asksForSecrets,
  BCORP_KEY,
  BRAND_KEYS,
  BRANDS,
  looksLikeBrand,
  NAME_ROLE_WORDS,
  ROLE_WORDS,
  senderTrust,
} from './senderTrust';
// The server's list (CommonJS); the two must not drift.
import guard from '../../../site/lib/brandGuard.js';

const OTHER = `02${'a'.repeat(64)}`;

describe('bMail sender trust (28 Oct 2026)', () => {
  test("bCorp's identity key is verified, whatever the name", () => {
    expect(senderTrust(BCORP_KEY, 'bcorp@bwalletx.com')).toBe('verified');
    expect(senderTrust(BCORP_KEY.toUpperCase(), 'Anyone')).toBe('verified');
  });
  test('look-alike senders get the warning', () => {
    for (const l of [
      'bc0rp@bwalletx.com',
      'bwallet-support@bwalletx.com',
      'bcorp',
      'B Wallet Support',
      'Kintsugi Team',
      'b support',
      'bchatx.x',
      'bwa11etx',
    ])
      expect([l, senderTrust(OTHER, l)]).toEqual([l, 'lookalike']);
  });
  test('false-positive guards', () => {
    for (const l of ['bob@bwalletx.com', 'bella', 'ab12cd@bwalletx.com', 'Mike B', 'Bob Corp', 'Barbara'])
      expect([l, looksLikeBrand(l)]).toEqual([l, false]);
  });
  test('asks for secrets', () => {
    for (const t of [
      'Please send your seed phrase',
      'reply with your 12 words',
      'enter your recovery phrase',
      'we need your private key',
      'confirm your password',
      'type the twelve secret words',
    ])
      expect([t, asksForSecrets(t)]).toEqual([t, true]);
    for (const t of ['See you at 12', 'Here are my words of thanks', 'The key to success', 'Lunch on Friday?'])
      expect([t, asksForSecrets(t)]).toEqual([t, false]);
  });
  test('1 is read as both l and i', () => {
    for (const l of ['k1ntsugi', 'b1tcoincorp@bwalletx.com', 'bwa11et'])
      expect([l, looksLikeBrand(l)]).toEqual([l, true]);
    for (const l of ['bi11y', 'Mi1es']) expect([l, looksLikeBrand(l)]).toEqual([l, false]);
  });
  test('the bWalletX brand account is not flagged; only bCorp gets the bCorp badge', () => {
    expect(senderTrust(BRAND_KEYS[1], 'bwalletx@bwalletx.com')).toBe('none');
    expect(BRAND_KEYS[0]).toBe(BCORP_KEY);
  });
  test('brand lists match site/lib/brandGuard.js', () => {
    expect([...BRANDS]).toEqual([...guard.BRANDS]);
    expect([...ROLE_WORDS]).toEqual([...guard.ROLE_WORDS]);
    expect([...NAME_ROLE_WORDS]).toEqual([...guard.NAME_ROLE_WORDS]);
  });
});
