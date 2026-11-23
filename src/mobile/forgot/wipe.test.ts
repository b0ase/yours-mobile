import { describe, expect, test } from 'bun:test';
import { RESTORE_ROUTE, WipeError, forgotPasswordWipe, initialRoute, wipeLocalWallet } from './wipe';

const makeFakes = () => {
  const log: string[] = [];
  const secure = new Map([
    ['bio:enrolled:acct1', '1'],
    ['bio:declined', '1'],
    ['other', 'x'],
  ]);
  const chrome = {
    runtime: {
      sendMessage: (m: { action: string }, cb?: () => void): number => {
        log.push(`msg:${m.action}`);
        cb?.();
        return 0;
      },
      lastError: undefined,
    },
    storage: {
      local: { clear: async () => void log.push('local.clear') },
      session: { clear: async () => void log.push('session.clear') },
    },
  };
  const native = {
    biometricRemove: async ({ key }: { key: string }) => void log.push(`bio.remove:${key}`),
    secureKeys: async () => ({ keys: [...secure.keys()] }),
    secureRemove: async ({ key }: { key: string }) => void secure.delete(key),
  };
  const idb = {
    databases: async () => [{ name: 'wallet-toolbox-abc' }, { name: 'blockHeaders' }, { name: 'txos-1-main' }],
    deleteDatabase: (name: string) => {
      log.push(`idb.delete:${name}`);
      const req: { onsuccess?: () => void; onerror?: unknown; onblocked?: unknown } = {};
      queueMicrotask(() => req.onsuccess?.());
      return req as unknown as IDBOpenDBRequest;
    },
  };
  const flags = new Map<string, string>();
  const session = { setItem: (k: string, v: string) => void flags.set(k, v) };
  return { log, secure, chrome, native, idb, session, flags };
};

describe('wipeLocalWallet', () => {
  test('clears biometrics, storage and wallet IndexedDB, then flags the restore screen', async () => {
    const f = makeFakes();
    await wipeLocalWallet({ ...f, wait: async () => undefined });
    expect(f.log[0]).toBe('bio.remove:');
    expect([...f.secure.keys()]).toEqual(['other']);
    expect(f.log).toContain('local.clear');
    expect(f.log).toContain('session.clear');
    expect(f.log).toContain('msg:signedOut');
    expect(f.log).toContain('idb.delete:wallet-toolbox-abc');
    expect(f.log).toContain('idb.delete:txos-1-main');
    expect(f.log).not.toContain('idb.delete:blockHeaders');
    expect(f.flags.size).toBe(1);
  });

  test('closes pairings and clears DOM localStorage: pairing sessions and every other wallet key (b-Aware report)', async () => {
    const f = makeFakes();
    const local = new Map([
      ['bwallet.pair.sessions', JSON.stringify([{ c: 'x', phoneKey: 'ab'.repeat(32) }])],
      ['bwallet.pair.revokeQueue', '["a.paired.invalid"]'],
      ['bwallet.agent.reportOutbox', '[]'],
      ['bwx.connectTheme.cache', '{}'],
      ['yours-x', '1'],
    ]);
    let closed = 0;
    await wipeLocalWallet({
      ...f,
      local: { clear: () => local.clear() },
      closePairings: () => void closed++,
      wait: async () => undefined,
    });
    expect(closed).toBe(1);
    expect(local.size).toBe(0);
  });

  test('initialRoute returns the restore screen once after a wipe', () => {
    const store = new Map<string, string>();
    const g = globalThis as { sessionStorage?: unknown };
    const prev = Object.getOwnPropertyDescriptor(g, 'sessionStorage');
    g.sessionStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    try {
      expect(initialRoute()).toBe('/');
      store.set('bwallet:open-restore', '1');
      expect(initialRoute()).toBe(RESTORE_ROUTE);
      expect(initialRoute()).toBe('/');
    } finally {
      // bun runs every test file in one process: don't leave the stub for the next file.
      if (prev) Object.defineProperty(g, 'sessionStorage', prev);
      else delete g.sessionStorage;
    }
  });
});

/**
 * Delete account › "Remove the wallet from this phone" did nothing (owner's iPhone, bWallet 5.2.61 build 155, 23 Nov
 * 2026). On the phone the background runs in the page and keeps the wallet's IndexedDB stores open. WebKit queues a
 * deleteDatabase behind the background's own (unhandled, blocked) one and fires nothing at all, not even `blocked`,
 * until every connection closes, so the wipe's await never returned and the button never reloaded.
 */
describe('wipeLocalWallet never hangs (Delete account, 5.2.61)', () => {
  /** A WebKit-like IndexedDB: a delete answers only once no connection is open, and fires no `blocked` at all. */
  const webkitIdb = (names: string[]) => {
    const dbs = new Set(names);
    let open = true;
    const waiting: Array<() => void> = [];
    return {
      dbs,
      closeAll: () => {
        open = false;
        for (const w of waiting.splice(0)) w();
      },
      idb: {
        databases: async () => [...dbs].map((name) => ({ name })),
        deleteDatabase: (name: string) => {
          const req: { onsuccess?: () => void; onerror?: unknown; onblocked?: unknown } = {};
          const finish = () => {
            dbs.delete(name);
            req.onsuccess?.();
          };
          if (open) waiting.push(finish);
          else queueMicrotask(finish);
          return req as unknown as IDBOpenDBRequest;
        },
      },
    };
  };
  const phoneFakes = () => {
    const f = makeFakes();
    // The phone's storage.local lives in the Keychain as `chrome.storage.local:<key>` items.
    f.secure.set('chrome.storage.local:accounts', '{"1abc":{"encryptedKeys":"x"}}');
    f.secure.set('chrome.storage.local:selectedAccount', '"1abc"');
    f.chrome.storage.local.clear = async () => {
      f.log.push('local.clear');
      for (const k of [...f.secure.keys()]) if (k.startsWith('chrome.storage.local:')) f.secure.delete(k);
    };
    return f;
  };

  test('closes the in-page wallet before deleting its databases, so the deletes complete', async () => {
    const f = phoneFakes();
    const w = webkitIdb(['wallet-toolbox-abc', 'txos-1abc-main', 'blockHeaders']);
    await wipeLocalWallet({
      ...f,
      idb: w.idb,
      restore: false,
      wait: async () => undefined,
      closeWallet: async () => w.closeAll(),
    });
    expect([...w.dbs]).toEqual(['blockHeaders']);
    expect([...f.secure.keys()].filter((k) => k.startsWith('chrome.storage.local:'))).toEqual([]);
  });

  test('a connection that never closes still ends the wipe within its caps, keys removed', async () => {
    const f = phoneFakes();
    const w = webkitIdb(['wallet-toolbox-abc']);
    const t0 = Date.now();
    await wipeLocalWallet({
      ...f,
      idb: w.idb,
      restore: false,
      wait: async () => undefined,
      closeWallet: () => new Promise<void>(() => undefined),
      caps: { closeMs: 50, dbMs: 50, stepMs: 50 },
    });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect([...f.secure.keys()].filter((k) => k.startsWith('chrome.storage.local:'))).toEqual([]);
  });

  test('a storage clear that never answers fails with a clear error instead of hanging', async () => {
    const f = phoneFakes();
    f.chrome.storage.local.clear = () => new Promise<void>(() => undefined);
    const t0 = Date.now();
    let err: unknown;
    await wipeLocalWallet({
      ...f,
      restore: false,
      wait: async () => undefined,
      closeWallet: async () => undefined,
      caps: { closeMs: 50, dbMs: 50, stepMs: 50 },
    }).catch((e) => (err = e));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(String(err)).toMatch(/could not remove/i);
  });

  test('keys written back after the clear are swept; keys that cannot be removed fail the wipe', async () => {
    const f = phoneFakes();
    // The background re-saves the accounts after the clear (a sync finishing late).
    f.chrome.runtime.sendMessage = (m: { action: string }, cb?: () => void) => {
      f.log.push(`msg:${m.action}`);
      if (m.action === 'signedOut') f.secure.set('chrome.storage.local:accounts', '{"1abc":{"encryptedKeys":"x"}}');
      cb?.();
      return 0;
    };
    await wipeLocalWallet({ ...f, restore: false, wait: async () => undefined, closeWallet: async () => undefined });
    expect([...f.secure.keys()].filter((k) => k.startsWith('chrome.storage.local:'))).toEqual([]);

    const g = phoneFakes();
    g.native.secureRemove = async ({ key }: { key: string }) => {
      if (key.startsWith('chrome.storage.local:')) throw new Error('Secure remove failed (-25300)');
      g.secure.delete(key);
    };
    g.chrome.storage.local.clear = async () => void g.log.push('local.clear'); // the clear left the Keychain items
    let err: unknown;
    await wipeLocalWallet({
      ...g,
      restore: false,
      wait: async () => undefined,
      closeWallet: async () => undefined,
    }).catch((e) => (err = e));
    expect(String(err)).toMatch(/could not remove/i);
  });

  test('Delete account removes every secure item on the device (agent keys, invite vaults, sign-in tokens)', async () => {
    const f = phoneFakes();
    f.secure.set('agent:key:anthropic', 'sk-x');
    await wipeLocalWallet({ ...f, restore: false, wait: async () => undefined, closeWallet: async () => undefined });
    expect([...f.secure.keys()]).toEqual([]);
  });
});

describe('wipeLocalWallet over fake-indexeddb', () => {
  test('the wallet store open in this page is closed first, then every wallet database is gone', async () => {
    const { IDBFactory } = await import('fake-indexeddb');
    const idb = new IDBFactory();
    const open = (name: string) =>
      new Promise<IDBDatabase>((resolve) => {
        const r = idb.open(name, 1);
        r.onsuccess = () => resolve(r.result);
      });
    const wallet = await open('wallet-toolbox-1abc-main'); // the in-page StorageIdb: ignores versionchange
    wallet.onversionchange = () => undefined;
    (await open('blockHeaders')).close();
    const f = makeFakes();
    await wipeLocalWallet({
      ...f,
      idb,
      restore: false,
      wait: async () => undefined,
      closeWallet: async () => wallet.close(),
    });
    expect((await idb.databases()).map((d) => d.name)).toEqual(['blockHeaders']);
  });
});

describe('round 2 (key-wipe review of 04f9513b)', () => {
  test('L2: Delete account requires secure storage to list EMPTY afterwards', async () => {
    const f = makeFakes();
    f.secure.set('agent:key:anthropic', 'sk-x');
    f.native.secureRemove = async ({ key }: { key: string }) => {
      if (key === 'agent:key:anthropic') throw new Error('Secure remove failed (-25244)');
      f.secure.delete(key);
    };
    let err: unknown;
    await wipeLocalWallet({
      ...f,
      restore: false,
      wait: async () => undefined,
      closeWallet: async () => undefined,
    }).catch((e) => (err = e));
    expect(err).toBeInstanceOf(WipeError);
  });

  test('L1: Forgot password reloads only after a wipe that worked; a failure is shown instead', async () => {
    const log: string[] = [];
    const reload = () => void log.push('reload');
    expect(await forgotPasswordWipe(async () => undefined, reload)).toBe('');
    expect(log).toEqual(['reload']);
    log.length = 0;
    const msg = await forgotPasswordWipe(async () => {
      throw new WipeError('Could not remove the wallet keys from this phone.');
    }, reload);
    expect(msg).toMatch(/Could not remove the wallet keys/);
    expect(msg).toMatch(/restart the app/i);
    expect(log).toEqual([]);
  });
});
