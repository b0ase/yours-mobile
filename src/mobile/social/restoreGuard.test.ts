import { afterEach, describe, expect, it, mock } from 'bun:test';
import { getKeys } from '../../utils/keys';

const realConfig = await import('../names/config');
mock.module('../names/config', () => ({ ...realConfig, BWALLET_PAYMAIL_DOMAIN: 'bwalletx.com' }));
const realSocial = await import('./socialLogin');
mock.module('./socialLogin', () => ({ ...realSocial, socialProfile: () => ({ alias: 'someone.x' }) }));
const { checkRestoreMatchesName } = await import('./restoreGuard');

// Throwaway test phrases (BIP39 test vectors), never real wallets.
const OWNER = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

const realFetch = globalThis.fetch;
const serve = (pki: Response) =>
  (globalThis.fetch = (async (u: string) =>
    u.includes('.well-known/bsvalias')
      ? new Response(JSON.stringify({ capabilities: { pki: 'https://pay.test/id/{alias}@{domain.tld}' } }))
      : u.startsWith('https://pay.test/id/')
        ? pki
        : new Response('{}')) as typeof fetch);

afterEach(() => (globalThis.fetch = realFetch));

describe('checkRestoreMatchesName', () => {
  it('lets the owning phrase through', async () => {
    serve(new Response(JSON.stringify({ pubkey: getKeys(OWNER).identityPubKey })));
    expect(await checkRestoreMatchesName(OWNER, null, null, null)).toBe('');
  });
  it("refuses another wallet's phrase", async () => {
    serve(new Response(JSON.stringify({ pubkey: getKeys(OWNER).identityPubKey })));
    expect(await checkRestoreMatchesName(OTHER, null, null, null)).toMatch(/aren't the wallet that owns someone\.x/);
  });
  it('lets any phrase through when the name is free', async () => {
    serve(new Response('{"error":"not-found"}', { status: 404 }));
    expect(await checkRestoreMatchesName(OTHER, null, null, null)).toBe('');
  });
  it('fails closed when the lookup errors', async () => {
    serve(new Response('down', { status: 502 }));
    await expect(checkRestoreMatchesName(OWNER, null, null, null)).rejects.toThrow(/Couldn't check/);
  });
});
