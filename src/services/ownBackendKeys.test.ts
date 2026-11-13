import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { guardCrossSiteSigning } from './crossSiteSignGuard';
import {
  _resetOwnBackends,
  isAuthMessageArgs,
  isOwnBackend,
  learnOwnBackends,
  noteOwnBackend,
  OWN_BACKEND_REFUSAL,
  ownBackendsReady,
} from './ownBackendKeys';

const ADMIN = 'wallet-admin';
const STORAGE_KEY = '02' + 'ab'.repeat(32); // stands for wallet.1sat.app's identity key
const MAIL_KEY = '03' + 'cd'.repeat(32); // stands for messagebox.bwalletx.com's
const OTHER_KEY = '02' + 'ef'.repeat(32); // some BRC-103 app's own server
const auth = (counterparty: string) => ({
  protocolID: [2, 'auth message signature'],
  keyID: 'nonceA nonceB',
  counterparty,
  data: [1, 2, 3],
});

const g = globalThis as Record<string, unknown>;
const savedLocal = g.localStorage;
const savedChrome = g.chrome;
const mem = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
};
beforeEach(() => {
  g.localStorage = mem();
  delete g.chrome;
  _resetOwnBackends();
});
afterEach(() => {
  g.localStorage = savedLocal;
  if (savedChrome === undefined) delete g.chrome;
  else g.chrome = savedChrome;
  _resetOwnBackends();
});

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

describe("no site signs in as the user to the wallet's own servers (follow-up, 13 Nov 2026)", () => {
  test('the protocol is recognised however it is spelt', () => {
    expect(isAuthMessageArgs(auth(STORAGE_KEY))).toBe(true);
    expect(isAuthMessageArgs({ protocolID: [2, ' Auth  Message Signature '] })).toBe(true);
    expect(isAuthMessageArgs({ protocolID: [1, 'auth message signature'] })).toBe(false);
    expect(isAuthMessageArgs({ protocolID: [2, 'good login'] })).toBe(false);
  });

  test("the wallet's own BRC-103 call teaches the key; a site's call with it is then refused before any prompt", async () => {
    const { m, calls } = manager();
    // bMail / Spaces doors sign through the manager as the wallet itself (admin originator, or none).
    await m.createSignature(auth(MAIL_KEY), ADMIN);
    await m.createSignature(auth(STORAGE_KEY));
    expect(isOwnBackend(MAIL_KEY) && isOwnBackend(STORAGE_KEY)).toBe(true);
    for (const key of [MAIL_KEY, STORAGE_KEY]) {
      await expect(m.createSignature(auth(key), 'https://evil.example')).rejects.toThrow(OWN_BACKEND_REFUSAL);
      await expect(m.createHmac(auth(key), 'https://evil.example')).rejects.toThrow(OWN_BACKEND_REFUSAL);
    }
    expect(calls.length).toBe(2); // only the wallet's own two calls reached the manager
  });

  test('a site keeps BRC-103 with its own server, and other protocols to our keys are untouched', async () => {
    noteOwnBackend(STORAGE_KEY);
    const { m } = manager();
    await expect(m.createSignature(auth(OTHER_KEY), 'https://app.example')).resolves.toEqual({ signature: [9] });
    await expect(m.createSignature(auth('anyone'), 'https://app.example')).resolves.toEqual({ signature: [9] });
    await expect(
      m.createSignature(
        { protocolID: [2, 'bwallet sign in'], keyID: '1', counterparty: STORAGE_KEY, data: [1] },
        'x.y',
      ),
    ).resolves.toEqual({ signature: [9] });
  });

  test("a site's own BRC-103 calls never teach a key (only the wallet's do)", async () => {
    const { m } = manager();
    await m.createSignature(auth(OTHER_KEY), 'https://app.example');
    expect(isOwnBackend(OTHER_KEY)).toBe(false);
    await expect(m.createSignature(auth(OTHER_KEY), 'https://app.example')).resolves.toEqual({ signature: [9] });
  });

  test('learning from the toolbox Wallet class: StorageClient calls (no originator) teach, site calls do not', async () => {
    class FakeWallet {
      async createSignature(_args: unknown, _originator?: string) {
        return { signature: [1] };
      }
      async verifySignature(_args: unknown, _originator?: string) {
        return { valid: true };
      }
    }
    learnOwnBackends(FakeWallet, ADMIN);
    learnOwnBackends(FakeWallet, ADMIN); // idempotent
    const w = new FakeWallet();
    await w.createSignature(auth(STORAGE_KEY)); // StorageClient's AuthFetch
    await w.verifySignature(auth(MAIL_KEY), ADMIN); // checking a server's handshake
    await w.createSignature(auth(OTHER_KEY), 'https://app.example'); // a site, through the manager
    expect([isOwnBackend(STORAGE_KEY), isOwnBackend(MAIL_KEY), isOwnBackend(OTHER_KEY)]).toEqual([true, true, false]);
    expect(await w.createSignature(auth(STORAGE_KEY))).toEqual({ signature: [1] });
  });

  test('remembered across a restart, and the guard waits for the remembered keys before answering', async () => {
    noteOwnBackend(STORAGE_KEY);
    const saved = (g.localStorage as Storage).getItem('bwx-own-backend-keys');
    _resetOwnBackends();
    // A restart: memory empty, localStorage has the key; chrome.storage answers late with the mail server's key.
    let answer: (v: Record<string, unknown>) => void = () => {};
    g.chrome = {
      storage: {
        local: {
          get: () => new Promise<Record<string, unknown>>((r) => (answer = r)),
          set: async () => {},
        },
      },
    };
    expect(saved).toContain(STORAGE_KEY);
    const { m, calls } = manager();
    const pending = m.createSignature(auth(MAIL_KEY), 'https://evil.example');
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(0); // still waiting for chrome.storage
    answer({ 'bwx-own-backend-keys': [MAIL_KEY] });
    await expect(pending).rejects.toThrow(OWN_BACKEND_REFUSAL);
    await expect(m.createSignature(auth(STORAGE_KEY), 'https://evil.example')).rejects.toThrow(OWN_BACKEND_REFUSAL);
    await ownBackendsReady();
    expect(calls.length).toBe(0);
  });

  test('junk counterparties are not remembered', () => {
    for (const k of ['anyone', 'self', '04' + 'ab'.repeat(64), 'zz', 42]) noteOwnBackend(k);
    expect(isOwnBackend('anyone')).toBe(false);
  });
});
