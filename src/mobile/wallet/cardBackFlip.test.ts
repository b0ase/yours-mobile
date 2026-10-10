import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Android (owner, 11 Oct 2026): the card back's copy targets swallowed every tap, so it couldn't flip back.
const src = readFileSync(join(import.meta.dir, 'WalletCard.tsx'), 'utf8');
const css = readFileSync(join(import.meta.dir, '..', 'mobile.css'), 'utf8');
const front = src.slice(src.indexOf('{/* ── Front ── */}'), src.indexOf('{/* ── Back ── */}'));
const back = src.slice(src.indexOf('{/* ── Back ── */}'));

describe('wallet card back', () => {
  it('has a pen that flips back to the front, in the front pen spot', () => {
    expect(back).toContain('aria-label="Show the front of the card"');
    expect(back).toContain('bw-wcard-penflip bw-wcard-penflip-back');
  });
  it('no longer repeats the receive address (it is on the front)', () => {
    expect(back).not.toContain('Receive BSV');
    expect(back).not.toContain('Copy receive address');
  });
  it('the identity key text is not a tap target that stops the flip', () => {
    expect(back).not.toContain('onClick={stop}');
  });
  it('only the small icon copies the key, with a 44px touch target', () => {
    expect(back).toContain('aria-label="Copy identity key"');
    expect(css).toMatch(/\.bw-wcard-copyicon,\s*\.bw-wcard-stripe-copy \{[^}]*width: 44px;[^}]*height: 44px;/);
  });
  it('keeps a right gutter so the back pen never covers the signature or QR', () => {
    expect(css).toMatch(/\.bw-wcard-back \.bw-wcard-backbody \{\s*padding-right: 52px;/);
  });
});

describe('wallet card front address row', () => {
  it('puts the copy icon LEFT of the address, away from the $/BSV switch', () => {
    const row = front.slice(front.indexOf('aria-label="Copy BSV address"') - 200);
    expect(row.indexOf('aria-label="Copy BSV address"')).toBeLessThan(row.indexOf('aria-label="Your BSV address"'));
  });
  it('leaves clear space before the switch', () => {
    expect(css).toMatch(/\.bw-wcard-front \.bw-wcard-addrslot \{\s*margin-right: 20px;/);
  });
});

describe('handle shown once, fingerprint everywhere (owner, 11 Oct 2026)', () => {
  const drawer = readFileSync(join(import.meta.dir, '..', 'names', 'DrawerHandle.tsx'), 'utf8');
  const sheet = readFileSync(join(import.meta.dir, '..', '..', 'pages', 'requests', 'BundleSheet.tsx'), 'utf8');
  const switcher = readFileSync(join(import.meta.dir, '..', 'account', 'AccountSwitcher.tsx'), 'utf8');
  it('card front: under the handle only the fingerprint, never the paymail', () => {
    expect(front).toContain('bw-wcard-fingerprint');
    expect(front).not.toContain('t.full');
    expect(front).not.toContain('paymail}');
  });
  it('menu drawer does not repeat the paymail', () => {
    expect(drawer).not.toContain('${name} · Create your room');
  });
  it('account rows show handle + fingerprint', () => {
    expect(switcher).toContain('keyFingerprint(account.pubKeys?.identityPubKey)');
  });
  it('the approval sheet says which account signs, with the same fingerprint', () => {
    expect(sheet).toContain('Signing in as');
    expect(sheet).toContain('keyFingerprint(signer?.pubKeys?.identityPubKey)');
  });
});
