import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { guardCrossSiteSigning } from './crossSiteSignGuard';
import {
  _resetOwnBackends,
  clearLearnedOwnBackends,
  FIRST_PARTY_SERVER_KEYS,
  isAuthMessageArgs,
  isOwnBackend,
  LEGACY_STORE_KEY,
  OWN_BACKEND_PENDING,
  OWN_BACKEND_REFUSAL,
  setOwnServerSource,
  storageServers,
  trackOwnAuthFetch,
} from './ownBackendKeys';

const ADMIN = 'wallet-admin';
const BMAIL_KEY = '021a8c3e9649e43fbc981aaf9cc366ccf0955df11bd79ef97b86c27387c5ca6723'; // messagebox.bwalletx.com
const ONESAT_KEY = '0326a9865e5ec9809b72c92b82c86e5a39ca00c2fd215920e96f42477721425d4b'; // wallet.1sat.app etc.
const CUSTOM_STORAGE_KEY = '02' + 'ab'.repeat(32);
const SITE_SERVER_KEY = '02' + 'ef'.repeat(32); // a BRC-103 app's own server (or a certifier)
const auth = (counterparty: string) => ({
  protocolID: [2, 'auth message signature'],
  keyID: 'nonceA nonceB',
  counterparty,
  data: [1, 2, 3],
});

beforeEach(() => _resetOwnBackends());
afterEach(() => _resetOwnBackends());

const manager = () => {
  const calls: { args: unknown; originator?: string }[] = [];
  const m = {
    createSignature: async (args: unknown, originator?: string) => {
      calls.push({ args, originator });
      return { signature: [9] };
    },
    createHmac: async (args: unknown, originator?: string) => {
      calls.push({ args, originator });
      return { hmac: [9] };
    },
  };
  return { m: guardCrossSiteSigning(m, ADMIN), calls };
};
const SITE = 'https://evil.example';

describe("no site signs in as the user to the wallet's own servers (review 13 Nov 2026)", () => {
  test('the protocol is recognised however it is spelt', () => {
    expect(isAuthMessageArgs(auth(BMAIL_KEY))).toBe(true);
    expect(isAuthMessageArgs({ protocolID: [2, ' Auth  Message Signature '] })).toBe(true);
    expect(isAuthMessageArgs({ protocolID: [1, 'auth message signature'] })).toBe(false);
  });

  test('the first-party keys are seeded: refused for a site from the first call, even on a fresh install (A2)', async () => {
    expect(Object.keys(FIRST_PARTY_SERVER_KEYS)).toEqual([BMAIL_KEY, ONESAT_KEY]);
    const { m, calls } = manager();
    for (const key of [BMAIL_KEY, ONESAT_KEY, BMAIL_KEY.toUpperCase().replace(/^0/, '0')]) {
      await expect(m.createSignature(auth(key), SITE)).rejects.toThrow(OWN_BACKEND_REFUSAL);
      await expect(m.createHmac(auth(key), SITE)).rejects.toThrow(OWN_BACKEND_REFUSAL);
    }
    expect(calls.length).toBe(0);
    // The wallet itself (bMail, storage) still signs to them.
    await m.createSignature(auth(BMAIL_KEY), ADMIN);
    await m.createSignature(auth(ONESAT_KEY));
    expect(calls.length).toBe(2);
  });

  test("nothing is learned from signing calls: a certifier the wallet signs in to doesn't become refused (A1, A1b)", async () => {
    const { m } = manager();
    // acquireCertificate issuance: the wallet itself signs in to a site-named certifier, many keys over time.
    for (let i = 0; i < 300; i++) await m.createSignature(auth('02' + i.toString(16).padStart(64, '0')), ADMIN);
    await m.createSignature(auth(SITE_SERVER_KEY));
    expect(isOwnBackend(SITE_SERVER_KEY)).toBe(false);
    // That site keeps BRC-103 with its own server, and the seeded keys stay refused.
    await expect(m.createSignature(auth(SITE_SERVER_KEY), 'https://certifier.example')).resolves.toEqual({
      signature: [9],
    });
    await expect(m.createSignature(auth(BMAIL_KEY), SITE)).rejects.toThrow(OWN_BACKEND_REFUSAL);
  });

  test('the stores in use: a remote store counts once connected; before that, a non-first-party one fails closed', async () => {
    const client = {
      endpointUrl: 'https://storage.custom.example',
      authClient: { peers: {} as Record<string, unknown> },
    };
    const firstParty = { endpointUrl: 'https://wallet.1sat.app', authClient: { peers: {} } };
    const storage = {
      _stores: [{ storage: firstParty }, { storage: client }, { storage: { isStorageProvider: true } }],
    };
    setOwnServerSource('storage', () => storageServers(storage));
    const { m } = manager();
    // Not connected yet: its key is unknown, so a site's BRC-103 signing waits (refused, try again).
    await expect(m.createSignature(auth(SITE_SERVER_KEY), SITE)).rejects.toThrow(OWN_BACKEND_PENDING);
    client.authClient.peers['https://storage.custom.example'] = { identityKey: CUSTOM_STORAGE_KEY };
    await expect(m.createSignature(auth(CUSTOM_STORAGE_KEY), SITE)).rejects.toThrow(OWN_BACKEND_REFUSAL);
    await expect(m.createSignature(auth(SITE_SERVER_KEY), SITE)).resolves.toEqual({ signature: [9] });
    // Other protocols and counterparties are untouched.
    await expect(
      m.createSignature({ ...auth(CUSTOM_STORAGE_KEY), protocolID: [2, 'bwallet sign in'] }, SITE),
    ).resolves.toEqual({
      signature: [9],
    });
    await expect(m.createSignature(auth('anyone'), SITE)).resolves.toEqual({ signature: [9] });
  });

  test('a bMail host override counts once its client has connected; the default host never waits', async () => {
    const af = { peers: {} as Record<string, unknown> };
    trackOwnAuthFetch('bmail', af, 'https://mail.selfhosted.example');
    const { m } = manager();
    await expect(m.createSignature(auth(SITE_SERVER_KEY), SITE)).rejects.toThrow(OWN_BACKEND_PENDING);
    af.peers['https://mail.selfhosted.example'] = { identityKey: CUSTOM_STORAGE_KEY };
    await expect(m.createSignature(auth(CUSTOM_STORAGE_KEY), SITE)).rejects.toThrow(OWN_BACKEND_REFUSAL);
    trackOwnAuthFetch('bmail', { peers: {} }, 'https://messagebox.bwalletx.com');
    await expect(m.createSignature(auth(SITE_SERVER_KEY), SITE)).resolves.toEqual({ signature: [9] });
  });

  test('keys saved by the earlier learning build are cleared on upgrade', () => {
    const g = globalThis as Record<string, unknown>;
    const savedLocal = g.localStorage;
    const savedChrome = g.chrome;
    const m = new Map<string, string>([[LEGACY_STORE_KEY, JSON.stringify([SITE_SERVER_KEY])]]);
    const removed: string[] = [];
    g.localStorage = { removeItem: (k: string) => void m.delete(k), getItem: (k: string) => m.get(k) ?? null };
    g.chrome = { storage: { local: { remove: async (k: string) => void removed.push(k) } } };
    try {
      clearLearnedOwnBackends();
      expect(m.has(LEGACY_STORE_KEY)).toBe(false);
      expect(removed).toEqual([LEGACY_STORE_KEY]);
      expect(isOwnBackend(SITE_SERVER_KEY)).toBe(false);
    } finally {
      g.localStorage = savedLocal;
      if (savedChrome === undefined) delete g.chrome;
      else g.chrome = savedChrome;
    }
  });
});
