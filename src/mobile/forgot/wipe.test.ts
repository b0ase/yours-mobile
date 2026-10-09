import { describe, expect, test } from 'bun:test';
import { RESTORE_ROUTE, initialRoute, openRestore, wipeLocalWallet } from './wipe';

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
  const localFlags = new Map<string, string>();
  const local = { setItem: (k: string, v: string) => void localFlags.set(k, v) };
  return { log, secure, chrome, native, idb, session, flags, local, localFlags };
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
    // Also in localStorage: the restore screen can open in another page (extension tab, app behind an overlay).
    expect(f.localFlags.get('bwallet:open-restore')).toBe('1');
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

  test('initialRoute also picks up the flag from localStorage (a new extension tab)', () => {
    const local = new Map<string, string>([['bwallet:open-restore', '1']]);
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => local.get(k) ?? null,
      setItem: (k: string, v: string) => void local.set(k, v),
      removeItem: (k: string) => void local.delete(k),
    };
    expect(initialRoute()).toBe(RESTORE_ROUTE);
    expect(local.size).toBe(0);
    expect(initialRoute()).toBe('/');
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
});

describe('openRestore', () => {
  const env = (pathname: string, opts: { framed?: 'same' | 'cross'; protocol?: string } = {}) => {
    const log: string[] = [];
    const self = {} as Window;
    const top = !opts.framed
      ? self
      : opts.framed === 'same'
        ? ({ location: { reload: () => log.push('top.reload') } } as unknown as Window)
        : ({
            get location(): never {
              throw new Error('cross-origin');
            },
          } as unknown as Window);
    return {
      log,
      e: {
        location: { pathname, protocol: opts.protocol ?? 'https:', reload: () => log.push('reload') },
        self,
        top,
        close: () => log.push('close'),
        chrome: {
          runtime: {
            getURL: (p: string) => `chrome-extension://id/${p}`,
            sendMessage: (m: { action: string }) => log.push(`msg:${m.action}`),
          },
          tabs: { create: ({ url }: { url: string }) => log.push(`tab:${url}`) },
        },
      },
    };
  };

  test('the wallet page reloads itself', () => {
    const { log, e } = env('/index.html');
    openRestore(e);
    expect(log).toEqual(['reload']);
  });

  test('a prompt overlay frame (phone, web wallet) reloads the wallet behind it', () => {
    const { log, e } = env('/prompt.html', { framed: 'same' });
    openRestore(e);
    expect(log).toEqual(['top.reload']);
  });

  test('the extension prompt (popup window or in-page sheet) opens the wallet in a tab and closes', () => {
    for (const framed of [undefined, 'cross'] as const) {
      const { log, e } = env('/prompt.html', { framed, protocol: 'chrome-extension:' });
      openRestore(e);
      expect(log).toEqual(['tab:chrome-extension://id/index.html', 'msg:DISMISS_PROMPT_PANEL', 'close']);
    }
  });
});
