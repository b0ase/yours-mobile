/**
 * Web wallet storage.local writes are all-or-nothing (re-review R2 of fix/web-one-tab, 13 Nov 2026). The web fallback
 * wrote each key with its own localStorage.setItem; a password change writes `accounts` and `salt` in one set, and a
 * full localStorage could keep one and drop the other: a lockout. The reviewer's probe (zzProbe4) as repo tests, plus
 * a real password change (real key derivation and encryption) against a nearly full localStorage.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { applyAtomically, isQuotaError } from './atomicStorage';
import { Hub, nativeLocalBackend, WEB_SECURE_PREFIX, type LocalBackend } from './hub';
import { decrypt, encrypt, generateWalletSalt } from '../utils/crypto';
import { derivePassKey } from '../services/passKey';

const quota = () => Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });

/** localStorage with a size limit (characters of keys + values), like a browser's ~5 MB. */
const limitedStorage = (capacity = Infinity, initial: Record<string, string> = {}) => {
  const items = new Map(Object.entries(initial));
  const size = () => [...items].reduce((n, [k, v]) => n + k.length + v.length, 0);
  const s = {
    items,
    capacity,
    size,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => {
      const next = size() - (items.has(k) ? k.length + items.get(k)!.length : 0) + k.length + v.length;
      if (next > s.capacity) throw quota();
      items.set(k, v);
    },
    removeItem: (k: string) => void items.delete(k),
    key: (i: number) => [...items.keys()][i] ?? null,
    get length() {
      return items.size;
    },
  };
  return s;
};

describe('applyAtomically', () => {
  test('quota mid-batch: every key is put back as it was, and the error is rethrown', () => {
    const s = limitedStorage(Infinity, { a: 'old-a', b: 'old-b', gone: 'still-here' });
    s.capacity = s.size() + 3;
    expect(() => applyAtomically(s, { a: 'new-a', b: 'x'.repeat(60) }, ['gone'])).toThrow('quota');
    expect(Object.fromEntries(s.items)).toEqual({ a: 'old-a', b: 'old-b', gone: 'still-here' });
  });

  test('quota: disposable caches are dropped and the whole op retried once', () => {
    const s = limitedStorage(Infinity, { a: 'old', 'bwallet:list-cache:tokens': 'x'.repeat(200) });
    s.capacity = s.size() + 2;
    applyAtomically(s, { a: 'new-and-longer-value', b: 'brand new' }, [], {
      freeSpace: () => {
        s.removeItem('bwallet:list-cache:tokens');
        return 1;
      },
    });
    expect(Object.fromEntries(s.items)).toEqual({ a: 'new-and-longer-value', b: 'brand new' });
  });

  test('quota with nothing to free: restored, rethrown (no retry loop)', () => {
    const s = limitedStorage(Infinity, { a: 'old' });
    s.capacity = s.size();
    let calls = 0;
    expect(() =>
      applyAtomically(s, { a: 'longer value', b: 'x' }, [], {
        freeSpace: () => {
          calls++;
          return 0;
        },
      }),
    ).toThrow('quota');
    expect(calls).toBe(1);
    expect(Object.fromEntries(s.items)).toEqual({ a: 'old' });
  });

  test('any other error: restored and rethrown without freeing anything', () => {
    const s = limitedStorage(Infinity, { a: 'old' });
    const setItem = s.setItem;
    s.setItem = (k, v) => {
      if (k === 'b') throw new Error('SecurityError');
      setItem(k, v);
    };
    let freed = false;
    expect(() => applyAtomically(s, { a: 'new', b: 'x' }, [], { freeSpace: () => ((freed = true), 1) })).toThrow(
      'SecurityError',
    );
    expect(freed).toBe(false);
    expect(Object.fromEntries(s.items)).toEqual({ a: 'old' });
  });

  test('isQuotaError knows the browsers’ names', () => {
    expect(isQuotaError(quota())).toBe(true);
    expect(isQuotaError(Object.assign(new Error('x'), { name: 'NS_ERROR_DOM_QUOTA_REACHED' }))).toBe(true);
    expect(isQuotaError(new Error('SecurityError'))).toBe(false);
  });
});

describe('web storage.local (nativeLocalBackend on the web) is all-or-nothing', () => {
  const g = globalThis as { localStorage?: unknown; sessionStorage?: unknown };
  const had = { local: 'localStorage' in g, session: 'sessionStorage' in g };
  const prev = g.localStorage;
  let ls = limitedStorage();
  beforeAll(() => {
    if (!had.session) g.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  });
  afterAll(() => {
    if (had.local) g.localStorage = prev;
    else delete g.localStorage;
    if (!had.session) delete g.sessionStorage;
  });
  const useStorage = (s: ReturnType<typeof limitedStorage>) => {
    ls = s;
    g.localStorage = s;
  };

  test('reviewer probe: quota on accounts mid-batch no longer leaves the new salt beside the old accounts', async () => {
    useStorage(
      limitedStorage(Infinity, {
        'secure:chrome.storage.local:accounts': 'OLDACCTS',
        'secure:chrome.storage.local:salt': 'OLDSALT',
      }),
    );
    const setItem = ls.setItem;
    ls.setItem = (k, v) => {
      if (k.endsWith(':accounts') && v.length > 8) throw quota();
      setItem(k, v);
    };
    await expect(
      nativeLocalBackend.apply(
        { 'chrome.storage.local:accounts': 'NEWACCOUNTS', 'chrome.storage.local:salt': 'NEWSALT' },
        [],
      ),
    ).rejects.toThrow('quota');
    expect(Object.fromEntries(ls.items)).toEqual({
      'secure:chrome.storage.local:accounts': 'OLDACCTS',
      'secure:chrome.storage.local:salt': 'OLDSALT',
    });
  });

  /** A hub over this localStorage, writing through the real web backend. */
  const webHub = () => {
    const backend: LocalBackend = {
      ...nativeLocalBackend,
      load: async () =>
        Object.fromEntries(
          [...ls.items].filter(([k]) => k.startsWith(WEB_SECURE_PREFIX)).map(([k, v]) => [k.slice(7), v]),
        ),
    };
    const hub = new Hub(async () => undefined, backend, { persistSession: false });
    let reqId = 0;
    const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    hub.register('background', {
      sender: { id: 'x', url: 'u', origin: 'o' },
      post: (json) => {
        const m = JSON.parse(json) as { t: string; reqId?: number; result?: unknown; error?: string };
        if (m.t !== 'storageResult' || m.reqId === undefined) return;
        const w = waiting.get(m.reqId);
        waiting.delete(m.reqId);
        if (m.error) w?.reject(new Error(m.error));
        else w?.resolve(m.result);
      },
    });
    const op = (o: 'get' | 'set', arg: unknown) =>
      new Promise<unknown>((resolve, reject) => {
        const id = ++reqId;
        waiting.set(id, { resolve, reject });
        void hub.handle('background', { t: 'storage', reqId: id, area: 'local', op: o, arg } as never);
      });
    return {
      get: async (k: string) => ((await op('get', k)) as Record<string, unknown>)[k],
      set: (items: Record<string, unknown>) => op('set', items),
    };
  };

  const stored = (key: string) => JSON.parse(ls.items.get(`secure:chrome.storage.local:${key}`)!) as unknown;

  /** ChromeStorageService.changePassword's write: every account re-encrypted under the new key, + salt, in ONE set. */
  const changePassword = async (
    hub: ReturnType<typeof webHub>,
    oldKey: string,
    newPassword: string,
  ): Promise<{ salt: string }> => {
    const accounts = (await hub.get('accounts')) as Record<string, { encryptedKeys: string }>;
    const salt = generateWalletSalt();
    const newKey = await derivePassKey(newPassword, salt, undefined);
    const next: Record<string, { encryptedKeys: string }> = {};
    for (const [id, a] of Object.entries(accounts))
      next[id] = { ...a, encryptedKeys: await encrypt(await decrypt(a.encryptedKeys, oldKey), newKey) };
    await hub.set({ accounts: next, salt });
    return { salt };
  };

  const unlocks = async (password: string) => {
    const key = await derivePassKey(password, stored('salt') as string, undefined);
    const accounts = stored('accounts') as Record<string, { encryptedKeys: string }>;
    return JSON.parse(await decrypt(accounts.main.encryptedKeys, key)) as { mnemonic: string };
  };

  test('full storage: a password change fails as a whole; old accounts AND old salt survive; the old password unlocks', async () => {
    useStorage(limitedStorage());
    const oldSalt = '0123456789abcdef'; // a legacy salt: shorter than the tagged one a change writes
    const oldKey = await derivePassKey('old password 1', oldSalt, undefined);
    const secret = JSON.stringify({ mnemonic: 'test words only' });
    const hub = webHub();
    await hub.set({ salt: oldSalt, accounts: { main: { encryptedKeys: await encrypt(secret, oldKey) } } });
    // Nearly full: room for the re-encrypted accounts (same size), not for the longer salt.
    ls.capacity = ls.size() + 4;

    await expect(changePassword(hub, oldKey, 'new password 2')).rejects.toThrow('quota');
    expect(stored('salt')).toBe(oldSalt);
    expect((await unlocks('old password 1')).mnemonic).toBe('test words only');
    // The hub's copy was put back too: the next read-merge-write can't write the half-change.
    expect(await hub.get('salt')).toBe(oldSalt);
  }, 30_000);

  test('full storage with caches: they are dropped, the change goes through, and the new password unlocks', async () => {
    useStorage(limitedStorage());
    const oldSalt = '0123456789abcdef';
    const oldKey = await derivePassKey('old password 1', oldSalt, undefined);
    const hub = webHub();
    await hub.set({
      salt: oldSalt,
      accounts: { main: { encryptedKeys: await encrypt(JSON.stringify({ mnemonic: 'm' }), oldKey) } },
    });
    ls.setItem('bwallet:list-cache:feed', 'x'.repeat(500));
    ls.capacity = ls.size() + 4;

    const { salt } = await changePassword(hub, oldKey, 'new password 2');
    expect(stored('salt')).toBe(salt);
    expect(ls.items.has('bwallet:list-cache:feed')).toBe(false);
    expect((await unlocks('new password 2')).mnemonic).toBe('m');
  }, 30_000);
});
