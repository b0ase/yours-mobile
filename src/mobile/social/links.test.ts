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

  test('eBay: the eBay user ID is the handle', () => {
    expect(linkHandle('ebay', 'Moisty_Collectibles*')).toBe('moisty_collectibles*');
    expect(linkHandle('ebay', 'someone@example.com')).toBe('');
    expect(badgeText({ provider: 'ebay', handle: 'moisty' })).toBe('moisty on eBay');
  });
});

describe('welcome screen: asking which providers are on (the bmarketx.com eBay status call)', () => {
  const on = { enabled: true, desktop: false, hidden: false, pending: false };
  test('asked only when the buttons will show', async () => {
    const { signupPanelAsks } = await import('./links');
    expect(signupPanelAsks(on)).toBe(true);
    expect(signupPanelAsks({ ...on, enabled: false })).toBe(false); // store build: no panel
    expect(signupPanelAsks({ ...on, desktop: true })).toBe(false); // Desktop: no panel
    expect(signupPanelAsks({ ...on, hidden: true })).toBe(false); // after Skip
    expect(signupPanelAsks({ ...on, pending: true })).toBe(false); // a started link is waiting
  });

  test('the panel uses it, and a store build returns before any fetch', async () => {
    const { readFileSync } = await import('node:fs');
    const panel = readFileSync(new URL('./SignupLinkPanel.tsx', import.meta.url), 'utf8');
    expect(panel).toContain('if (!asks) return;');
    const links = readFileSync(new URL('./links.ts', import.meta.url), 'utf8');
    const gate = links.indexOf('if (!LINK_ACCOUNTS_ENABLED) return DEFAULT_PROVIDERS;');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(links.indexOf('const ebay = ebayAvailable(f);'));
  });
});
