import { describe, expect, test } from 'bun:test';
import { RESTORE_ROUTE, initialRoute, wipeLocalWallet } from './wipe';

const makeFakes = () => {
  const log: string[] = [];
  const secure = new Map([
    ['bio:enrolled:acct1', '1'],
    ['bio:declined', '1'],
    ['other', 'x'],
  ]);
  const chrome = {
    runtime: { sendMessage: (m: { action: string }) => log.push(`msg:${m.action}`), lastError: undefined },
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

  test('initialRoute returns the restore screen once after a wipe', () => {
    const store = new Map<string, string>();
    (globalThis as { sessionStorage?: unknown }).sessionStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    expect(initialRoute()).toBe('/');
    store.set('bwallet:open-restore', '1');
    expect(initialRoute()).toBe(RESTORE_ROUTE);
    expect(initialRoute()).toBe('/');
  });
});
