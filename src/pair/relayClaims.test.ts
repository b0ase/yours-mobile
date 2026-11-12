import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { PrivateKey } from '@bsv/sdk';
import { claimDigest, claimDigestSync, newChannel, relaySocketUrl, sessionWalletClaim, walletClaimFor } from './protocol';

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

// Wallet claim v2 (12 Nov 2026). The vector is shared with bwalletx-connect and bwalletx-cli: keep them in step.
describe('session wallet claim (v2)', () => {
  const P = PrivateKey.fromHex('11'.repeat(32));
  const S = PrivateKey.fromHex('22'.repeat(32));
  const c = 'AAAAAAAAAAAAAAAAAAAAAA';
  const VECTOR = 'rTgy5TUbOz2xUwLyqYebrIyLaQifFhULNSSHHklw0gQ';

  test('both ends compute the same claim, and it matches the shared vector', () => {
    expect(sessionWalletClaim(P, S.toPublicKey().toString(), c)).toBe(VECTOR);
    expect(sessionWalletClaim(S, P.toPublicKey().toString(), c)).toBe(VECTOR);
    expect(VECTOR).toMatch(/^[A-Za-z0-9_-]{22,64}$/); // the relay's claim format
  });

  test('the QR alone is not enough: another pairing key gives another claim, and it is not the QR claim', () => {
    const k = S.toPublicKey().toString();
    const other = PrivateKey.fromRandom();
    expect(sessionWalletClaim(other, k, c)).not.toBe(VECTOR);
    expect(walletClaimFor(c, k)).not.toBe(VECTOR);
    expect(sessionWalletClaim(P, k, newChannel())).not.toBe(VECTOR);
  });

  test('claimDigestSync equals claimDigest', async () => {
    expect(claimDigestSync(VECTOR)).toBe(await claimDigest(VECTOR));
    expect(claimDigestSync(VECTOR)).toBe('70d13b85c6bf389eafdc3d9b1c155826fda8517003bf2f4a8600b4dc0d06e759');
  });

  test('a wallet socket carries the session digest as nc, never as wc', () => {
    const d = claimDigestSync(VECTOR);
    const u = new URL(relaySocketUrl('relay.bwallet.space', c, 'wallet', undefined, 'x'.repeat(22), d));
    expect(u.searchParams.get('nc')).toBe(d);
    expect(u.searchParams.get('wc')).toBeNull();
    const site = new URL(relaySocketUrl('relay.bwallet.space', c, 'site', 1, 'x'.repeat(22), d));
    expect(site.searchParams.get('nc')).toBeNull();
  });
});
