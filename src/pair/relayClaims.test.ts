import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { claimDigest, newChannel, relaySocketUrl, walletClaimFor } from './protocol';

// b-Aware 26 Oct 2026 (N3-2): the wallet's first claim comes from the QR, and the site registers its digest.
describe('QR-bound wallet claim', () => {
  test('is deterministic from the QR, differs per channel and site key, and fits the relay claim format', async () => {
    const c = newChannel();
    const k = '02' + 'ab'.repeat(32);
    const a = walletClaimFor(c, k);
    expect(a).toBe(walletClaimFor(c, k));
    expect(a).toMatch(/^[A-Za-z0-9_-]{22,64}$/);
    expect(a).not.toBe(walletClaimFor(newChannel(), k));
    expect(a).not.toBe(walletClaimFor(c, '03' + 'ab'.repeat(32)));
  });

  test('matches the WebCrypto derivation bwalletx-connect uses', async () => {
    const c = newChannel();
    const k = '02' + 'ef'.repeat(32);
    const d = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`bwallet-pair-wallet-claim-v1|${c}|${k}`)),
    );
    expect(walletClaimFor(c, k)).toBe(Buffer.from(d).toString('base64url'));
  });

  test('claimDigest matches the relay hash (SHA-256 hex of the claim)', async () => {
    const claim = walletClaimFor(newChannel(), '02' + 'cd'.repeat(32));
    expect(await claimDigest(claim)).toBe(createHash('sha256').update(claim).digest('hex'));
  });

  test('wc goes only on site sockets', () => {
    const c = newChannel();
    const wc = 'f'.repeat(64);
    expect(
      new URL(relaySocketUrl('relay.bwallet.space', c, 'site', 1, 'x'.repeat(22), wc)).searchParams.get('wc'),
    ).toBe(wc);
    expect(
      new URL(relaySocketUrl('relay.bwallet.space', c, 'wallet', undefined, 'x'.repeat(22), wc)).searchParams.get('wc'),
    ).toBeNull();
  });
});
