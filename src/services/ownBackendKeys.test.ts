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
  _ownServerKeyWrites,
  migrateServerKeys,
  saveOwnServerKey,
  savedOwnServerKeys,
  watchStoreConnections,
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

describe('polish (13 Nov 2026): "pending" never sticks', () => {
  const g = globalThis as Record<string, unknown>;
  let savedLocal: unknown;
  beforeEach(() => {
    savedLocal = g.localStorage;
    const m = new Map<string, string>();
    g.localStorage = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  });
  afterEach(() => {
    g.localStorage = savedLocal;
  });
  const ORIGIN = 'https://my-backup.example.org';

  test('a custom store that never connects is pending only until its time limit', () => {
    const storage = { _stores: [{ storage: { endpointUrl: `${ORIGIN}/`, authClient: { peers: {} } } }] };
    setOwnServerSource('storage', () => storageServers(storage, { pendingUntil: Date.now() + 60_000 }));
    expect(isOwnBackend(SITE_SERVER_KEY)).toBe(false);
    const { m } = manager();
    return Promise.all([
      expect(m.createSignature(auth(SITE_SERVER_KEY), SITE)).rejects.toThrow(OWN_BACKEND_PENDING),
      (async () => {
        setOwnServerSource('storage', () => storageServers(storage, { pendingUntil: Date.now() - 1 }));
        await expect(m.createSignature(auth(SITE_SERVER_KEY), SITE)).resolves.toEqual({ signature: [9] });
      })(),
    ]);
  });

  test('its key is saved when it first connects, and a later session uses the saved key (never pending)', async () => {
    const client = { endpointUrl: ORIGIN, authClient: { peers: {} as Record<string, unknown> } };
    const storage = { _stores: [{ storage: client }] };
    const saved: Record<string, string> = {};
    const learned: [string, string][] = [];
    const source = () =>
      storageServers(storage, {
        saved,
        onLearn: (o, k) => {
          learned.push([o, k]);
          saved[o] = k;
        },
        pendingUntil: Date.now() + 60_000,
      });
    setOwnServerSource('storage', source);
    client.authClient.peers[ORIGIN] = { identityKey: CUSTOM_STORAGE_KEY };
    expect(isOwnBackend(CUSTOM_STORAGE_KEY)).toBe(true);
    expect(isOwnBackend(CUSTOM_STORAGE_KEY)).toBe(true);
    expect(learned).toEqual([[ORIGIN, CUSTOM_STORAGE_KEY]]); // saved once
    // The SDK drops a stale session: its peer entry goes, the key stays.
    delete client.authClient.peers[ORIGIN];
    const { m } = manager();
    await expect(m.createSignature(auth(CUSTOM_STORAGE_KEY), SITE)).rejects.toThrow(OWN_BACKEND_REFUSAL);
    await expect(m.createSignature(auth(SITE_SERVER_KEY), SITE)).resolves.toEqual({ signature: [9] });
    // A new session (nothing in memory), not connected yet: the saved key counts and nothing is pending.
    _resetOwnBackends();
    setOwnServerSource('storage', () => storageServers(storage, { saved, pendingUntil: Date.now() + 60_000 }));
    await expect(m.createSignature(auth(CUSTOM_STORAGE_KEY), SITE)).rejects.toThrow(OWN_BACKEND_REFUSAL);
    await expect(m.createSignature(auth(SITE_SERVER_KEY), SITE)).resolves.toEqual({ signature: [9] });
  });

  test('a bMail host override: each new client keeps the key, and later sessions use the saved one', async () => {
    const host = 'https://mb.selfhost.example';
    const first = { peers: { [host]: { identityKey: CUSTOM_STORAGE_KEY } } };
    trackOwnAuthFetch('bmail', first, host);
    expect(isOwnBackend(CUSTOM_STORAGE_KEY)).toBe(true);
    // The next mbox() call makes a new client that hasn't connected: not pending, key still refused.
    trackOwnAuthFetch('bmail', { peers: {} }, host);
    const { m } = manager();
    await expect(m.createSignature(auth(SITE_SERVER_KEY), SITE)).resolves.toEqual({ signature: [9] });
    await expect(m.createSignature(auth(CUSTOM_STORAGE_KEY), SITE)).rejects.toThrow(OWN_BACKEND_REFUSAL);
    // Next session: memory empty, the key saved in localStorage.
    _resetOwnBackends();
    trackOwnAuthFetch('bmail', { peers: {} }, host);
    await expect(m.createSignature(auth(CUSTOM_STORAGE_KEY), SITE)).rejects.toThrow(OWN_BACKEND_REFUSAL);
    await expect(m.createSignature(auth(SITE_SERVER_KEY), SITE)).resolves.toEqual({ signature: [9] });
  });

  test('a bMail host override that never connects stops waiting after the time limit', async () => {
    const realNow = Date.now;
    const t0 = realNow();
    try {
      Date.now = () => t0;
      trackOwnAuthFetch('bmail', { peers: {} }, 'https://never.selfhost.example');
      const { m } = manager();
      await expect(m.createSignature(auth(SITE_SERVER_KEY), SITE)).rejects.toThrow(OWN_BACKEND_PENDING);
      // Each new client keeps the first-tracked time, so the limit isn't reset by every mbox() call.
      Date.now = () => t0 + 60_000;
      trackOwnAuthFetch('bmail', { peers: {} }, 'https://never.selfhost.example');
      Date.now = () => t0 + 2 * 60_000 + 1;
      await expect(m.createSignature(auth(SITE_SERVER_KEY), SITE)).resolves.toEqual({ signature: [9] });
    } finally {
      Date.now = realNow;
    }
  });
});

describe('saved store keys live under their own chrome.storage key, never in `accounts` (13 Nov 2026)', () => {
  const g = globalThis as Record<string, unknown>;
  let savedChrome: unknown;
  let store: Record<string, unknown>;
  let writes: string[];
  beforeEach(() => {
    savedChrome = g.chrome;
    store = { accounts: { ACCT: { storageConfig: { activeRemote: 'https://wallet.1sat.app' } } } };
    writes = [];
    g.chrome = {
      storage: {
        local: {
          get: async (k: string) => ({ [k]: structuredClone(store[k]) }),
          set: async (v: Record<string, unknown>) => {
            for (const k of Object.keys(v)) writes.push(k);
            Object.assign(store, structuredClone(v));
          },
        },
      },
    };
  });
  afterEach(() => {
    if (savedChrome === undefined) delete g.chrome;
    else g.chrome = savedChrome;
  });
  const ORIGIN = 'https://my-backup.example.org';

  test("a store key is saved when the wallet's own client connects, under bwx.ownServerKeys.<account> only", async () => {
    class FakeStorageClient {
      endpointUrl = `${ORIGIN}/`;
      authClient = { peers: {} as Record<string, unknown> };
      async makeAvailable() {
        this.authClient.peers[ORIGIN] = { identityKey: CUSTOM_STORAGE_KEY }; // the BRC-103 handshake
        return { storageIdentityKey: 'x' };
      }
    }
    watchStoreConnections(FakeStorageClient, () => 'ACCT');
    watchStoreConnections(FakeStorageClient, () => 'ACCT'); // idempotent
    const c = new FakeStorageClient();
    expect(await c.makeAvailable()).toEqual({ storageIdentityKey: 'x' });
    await _ownServerKeyWrites();
    expect(writes).toEqual(['bwx.ownServerKeys.ACCT']);
    expect(store['bwx.ownServerKeys.ACCT']).toEqual({ [ORIGIN]: CUSTOM_STORAGE_KEY });
    expect(store.accounts).toEqual({ ACCT: { storageConfig: { activeRemote: 'https://wallet.1sat.app' } } });
    // A later session: the store configured but not connected yet counts by its saved key (nothing pending).
    _resetOwnBackends();
    await migrateServerKeys('ACCT', undefined, async () => {});
    const notYet = { _stores: [{ storage: { endpointUrl: ORIGIN, authClient: { peers: {} } } }] };
    setOwnServerSource('storage', () =>
      storageServers(notYet, { saved: savedOwnServerKeys('ACCT'), pendingUntil: Date.now() + 60_000 }),
    );
    expect(isOwnBackend(CUSTOM_STORAGE_KEY)).toBe(true);
    const { m } = manager();
    await expect(m.createSignature(auth(SITE_SERVER_KEY), SITE)).resolves.toEqual({ signature: [9] });
  });

  test('saves are one at a time and merge within the account key; a new session loads them', async () => {
    saveOwnServerKey('ACCT', ORIGIN, CUSTOM_STORAGE_KEY);
    saveOwnServerKey('ACCT', 'https://other-backup.example', SITE_SERVER_KEY);
    saveOwnServerKey('ACCT', ORIGIN, CUSTOM_STORAGE_KEY); // unchanged: no write
    saveOwnServerKey('ACCT', 'not a url', SITE_SERVER_KEY); // ignored
    await _ownServerKeyWrites();
    expect(writes).toEqual(['bwx.ownServerKeys.ACCT', 'bwx.ownServerKeys.ACCT']);
    expect(store['bwx.ownServerKeys.ACCT']).toEqual({
      [ORIGIN]: CUSTOM_STORAGE_KEY,
      'https://other-backup.example': SITE_SERVER_KEY,
    });
    _resetOwnBackends();
    expect(savedOwnServerKeys('ACCT')).toEqual({});
    await migrateServerKeys('ACCT', undefined, async () => {
      throw new Error('no legacy field: never called');
    });
    expect(savedOwnServerKeys('ACCT')[ORIGIN]).toBe(CUSTOM_STORAGE_KEY);
  });

  test('keys an earlier candidate wrote into storageConfig.serverKeys move to the account key, then the field goes', async () => {
    let removed = 0;
    await migrateServerKeys('ACCT', { [ORIGIN]: CUSTOM_STORAGE_KEY, junk: 'x' }, async () => {
      removed++;
    });
    expect(removed).toBe(1);
    expect(store['bwx.ownServerKeys.ACCT']).toEqual({ [ORIGIN]: CUSTOM_STORAGE_KEY });
    expect(savedOwnServerKeys('ACCT')).toEqual({ [ORIGIN]: CUSTOM_STORAGE_KEY });
  });
});
