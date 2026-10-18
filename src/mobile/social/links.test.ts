import { describe, expect, test } from 'bun:test';
import { badgeText, linkFields, linkHandle } from './links';

describe('Link your accounts', () => {
  test('never a handle from an email; Google and LinkedIn have none', () => {
    expect(linkHandle('google', 'their.name@gmail.com')).toBe('');
    expect(linkHandle('x', 'someone@example.com')).toBe('');
    expect(linkHandle('linkedin', 'abc123')).toBe('');
    expect(linkHandle('x', '@B0aseX')).toBe('b0asex');
    expect(linkHandle('github', 'Octo-Cat')).toBe('octo-cat');
    expect(linkHandle('handcash', '$boase')).toBe('boase');
  });

  test('badge: Google shows only an email-verified tick', () => {
    expect(badgeText({ provider: 'google', handle: '', display: 'x@gmail.com' })).toBe('Google · email verified');
    expect(badgeText({ provider: 'x', handle: 'b0asex' })).toBe('@b0asex on X');
    expect(badgeText({ provider: 'handcash', handle: 'boase' })).toBe('$boase on HandCash');
  });

  test('signed fields hash the account id (no email inside) and need a real id', async () => {
    const f = await linkFields('google', '1234567890', 'their.name@gmail.com');
    expect(f.provider).toBe('google');
    expect(f.handle).toBe('');
    expect(f.account).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(f)).not.toContain('gmail');
    await expect(linkFields('x', '', 'b0asex')).rejects.toThrow();
  });
});
