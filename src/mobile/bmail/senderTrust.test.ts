import { describe, expect, test } from 'bun:test';
import { asksForSecrets, BCORP_KEY, looksLikeBrand, senderTrust } from './senderTrust';

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
});
