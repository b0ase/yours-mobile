/**
 * Web wallet, one active tab (13 Nov 2026). Each tab of web.bwalletx.com ran its own Hub (a copy of localStorage
 * loaded at start-up) and its own background worker, and wrote its whole stale copy back: an account imported in one
 * tab was removed by the other's next write. These tests open several "tabs" over one fake browser (shared
 * localStorage, Web Locks, BroadcastChannel and storage events) and check only one of them ever runs the wallet.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Hub, type LocalBackend } from './hub';
import {
  fencedBackend,
  isWebEdition,
  MOVED_ERROR,
  startWebTab,
  storageChannel,
  WEB_TAB_OWNER_KEY,
  WebTab,
  type ChannelLike,
  type LockManagerLike,
  type StorageLike,
  type WebTabEnv,
} from './webTab';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** One browser profile: one localStorage, one lock manager, one channel bus, shared by every tab. */
const fakeBrowser = (opts: { locks?: boolean; channel?: boolean } = {}) => {
  const items = new Map<string, string>();
  type TabIo = {
    frozen: boolean;
    storageListeners: Array<(e: { key: string | null; newValue: string | null }) => void>;
    channelListeners: Array<(e: { data: unknown }) => void>;
    deferred: Array<() => void>;
  };
  const tabs: TabIo[] = [];
  const deliver = (io: TabIo, fn: () => void) => setTimeout(() => (io.frozen ? io.deferred.push(fn) : fn()), 0);

  type Held = { io: TabIo; reject: (e: Error) => void; done: boolean };
  let held: Held | null = null;

  const makeTab = () => {
    const io: TabIo = { frozen: false, storageListeners: [], channelListeners: [], deferred: [] };
    tabs.push(io);
    const storage: StorageLike = {
      getItem: (k) => items.get(k) ?? null,
      setItem: (k, v) => {
        items.set(k, v);
        for (const other of tabs)
          if (other !== io) for (const l of other.storageListeners) deliver(other, () => l({ key: k, newValue: v }));
      },
      removeItem: (k) => {
        items.delete(k);
        for (const other of tabs)
          if (other !== io) for (const l of other.storageListeners) deliver(other, () => l({ key: k, newValue: null }));
      },
    };
    const locks: LockManagerLike = {
      request: (_name, o, cb) => {
        if (held && !held.done && o.ifAvailable) return Promise.resolve(cb(null));
        if (held && !held.done && !o.steal) return Promise.reject(new Error('queued requests not modelled'));
        if (held && !held.done && o.steal) {
          const prev = held;
          prev.done = true;
          const err = Object.assign(new Error('stolen'), { name: 'AbortError' });
          deliver(prev.io, () => prev.reject(err));
        }
        return new Promise((resolve, reject) => {
          const entry: Held = { io, reject, done: false };
          held = entry;
          void Promise.resolve(cb({ name: 'bwx-web-active' })).then((v) => {
            if (entry.done) return;
            entry.done = true;
            held = null;
            resolve(v);
          });
        });
      },
    };
    const channel: ChannelLike = {
      postMessage: (data) => {
        for (const other of tabs)
          if (other !== io) for (const l of other.channelListeners) deliver(other, () => l({ data }));
      },
      addEventListener: (_t, l) => void io.channelListeners.push(l),
    };
    let n = 0;
    const env: WebTabEnv = {
      locks: opts.locks === false ? undefined : locks,
      openChannel:
        opts.channel === false
          ? opts.locks === false
            ? () => storageChannel(storage, (fn) => io.storageListeners.push(fn))
            : undefined
          : () => channel,
      storage,
      onStorageEvent: (l) => void io.storageListeners.push((e) => l(e.key)),
      newId: () => `tab-${tabs.indexOf(io)}-${++n}`,
      now: () => Date.now(),
      takeoverWaitMs: 60,
      flushWaitMs: 200,
      stealWaitMs: 300,
      claimSettleMs: 10,
    };
    /** storage.local the way the web fallback keeps it (native.ts): `secure:` items in localStorage. */
    const backend: LocalBackend = {
      load: async () =>
        Object.fromEntries([...items].filter(([k]) => k.startsWith('secure:')).map(([k, v]) => [k.slice(7), v])),
      apply: async (sets, removes) => {
        for (const [k, v] of Object.entries(sets)) storage.setItem(`secure:${k}`, v);
        for (const k of removes) storage.removeItem(`secure:${k}`);
      },
    };
    return {
      env,
      backend,
      io,
      freeze: () => void (io.frozen = true),
      thaw: () => {
        io.frozen = false;
        io.deferred.splice(0).forEach((fn) => fn());
      },
    };
  };
  const local = (key: string) => {
    const raw = items.get(`secure:chrome.storage.local:${key}`);
    return raw === undefined ? undefined : JSON.parse(raw);
  };
  return { items, makeTab, local };
};

/** A hub with a background endpoint that talks chrome.storage.local, as background.ts does. */
const hubClient = (hub: Hub) => {
  let reqId = 0;
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  hub.register('background', {
    sender: { id: 'x', url: 'http://yours-mobile/background.js', origin: 'http://yours-mobile' },
    post: (json) => {
      const msg = JSON.parse(json) as { t: string; reqId?: number; result?: unknown; error?: string };
      if (msg.t !== 'storageResult' || msg.reqId === undefined) return;
      const w = waiting.get(msg.reqId);
      waiting.delete(msg.reqId);
      if (msg.error) w?.reject(new Error(msg.error));
      else w?.resolve(msg.result);
    },
  });
  const storage = (op: 'get' | 'set', arg: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++reqId;
      waiting.set(id, { resolve, reject });
      void hub.handle('background', { t: 'storage', reqId: id, area: 'local', op, arg } as never);
    });
  const get = async (key: string) => ((await storage('get', key)) as Record<string, unknown>)[key];
  const set = (key: string, value: unknown) => storage('set', { [key]: value });
  /** ChromeStorageService.updateNested('accounts', …): read this tab's copy, merge, write the whole map back. */
  const addAccount = async (id: string) => {
    const accounts = ((await get('accounts')) ?? {}) as Record<string, unknown>;
    await set('accounts', { ...accounts, [id]: { name: id } });
  };
  return { get, set, addAccount };
};

/** main.ts for the web, in miniature: claim, and only then build the hub and start the worker. */
const bootTab = (tab: ReturnType<ReturnType<typeof fakeBrowser>['makeTab']>) => {
  const webTab = new WebTab(tab.env);
  const out = {
    webTab,
    hub: undefined as Hub | undefined,
    client: undefined as ReturnType<typeof hubClient> | undefined,
    worker: 'never started' as 'never started' | 'running' | 'stopped',
    reloads: 0,
  };
  const startWallet = () => {
    const hub = new Hub(async () => undefined, fencedBackend(tab.backend, webTab), { persistSession: false });
    out.hub = hub;
    out.client = hubClient(hub);
    out.worker = 'running';
    webTab.onRelease(async () => {
      hub.fence();
      await hub.flush();
      out.worker = 'stopped';
    });
    webTab.onLost(() => void out.reloads++);
  };
  return {
    out,
    claim: async () => {
      if (await webTab.claim()) startWallet();
      return webTab.state === 'active';
    },
    takeOver: async () => {
      const ok = await webTab.takeOver();
      if (ok) startWallet();
      return ok;
    },
  };
};

describe('web wallet: one active tab', () => {
  const g = globalThis as { sessionStorage?: unknown };
  const hadSession = 'sessionStorage' in g;
  beforeAll(() => {
    if (!hadSession) g.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  });
  afterAll(() => {
    if (!hadSession) delete g.sessionStorage;
  });

  test('control (the bug): two hubs over one localStorage, and tab B’s routine write removes the account tab A imported', async () => {
    const browser = fakeBrowser();
    const a = browser.makeTab();
    const b = browser.makeTab();
    const hubA = hubClient(new Hub(async () => undefined, a.backend, { persistSession: false }));
    const hubB = hubClient(new Hub(async () => undefined, b.backend, { persistSession: false }));
    await hubA.addAccount('main');
    await hubB.get('accounts'); // B's copy is from start-up: no accounts... (loaded before A's write)
    await hubA.addAccount('imported');
    await hubB.addAccount('renamed');
    expect(Object.keys(browser.local('accounts'))).not.toContain('imported');
  });

  test('two tabs: the second never becomes active, never builds a hub, never starts the worker', async () => {
    const browser = fakeBrowser();
    const a = bootTab(browser.makeTab());
    const b = bootTab(browser.makeTab());
    expect(await a.claim()).toBe(true);
    expect(await b.claim()).toBe(false);
    expect(b.out.hub).toBeUndefined();
    expect(b.out.worker).toBe('never started');
    expect(b.out.webTab.isOwner()).toBe(false);
    expect(a.out.webTab.isOwner()).toBe(true);
    await tick(20);
    expect(a.out.webTab.state).toBe('active'); // B's claim did not disturb A
  });

  test('startWebTab: a second tab waits on the screen (so main.ts never builds a hub) until "Use here instead"', async () => {
    const browser = fakeBrowser();
    const a = bootTab(browser.makeTab());
    expect(await a.claim()).toBe(true);
    const doc = fakeDocument();
    let resolved = false;
    const started = startWebTab(browser.makeTab().env, doc as unknown as Document).then((t) => {
      resolved = true;
      return t;
    });
    await tick(30);
    expect(resolved).toBe(false);
    expect(doc.text()).toContain('bWalletX is open in another tab');
    doc.click('Use here instead');
    const tab = await started;
    expect(tab.state).toBe('active');
    expect(doc.body.children.length).toBe(0); // the screen is gone; the wallet boots
    await tick(20);
    expect(a.out.webTab.state).toBe('lost');
    expect(a.out.reloads).toBe(1);
  });

  test('takeover: the old tab flushes and stops; its later writes are refused; the new tab sees its last writes', async () => {
    const browser = fakeBrowser();
    const a = bootTab(browser.makeTab());
    await a.claim();
    await a.out.client!.set('note', 'first');
    // A write in flight as the takeover starts.
    const lastWrite = a.out.client!.set('note', 'last before handover');
    const b = bootTab(browser.makeTab());
    expect(await b.claim()).toBe(false);
    expect(await b.takeOver()).toBe(true);
    await lastWrite;
    expect(a.out.worker).toBe('stopped');
    await tick(20);
    expect(a.out.webTab.state).toBe('lost');
    expect(a.out.reloads).toBe(1);
    // The old tab's stale copy can never be written back.
    await expect(a.out.client!.set('note', 'stale')).rejects.toThrow(MOVED_ERROR);
    expect(browser.local('note')).toBe('last before handover');
    // The new tab's hub was built after the handover, from localStorage as the old tab left it.
    expect(await b.out.client!.get('note')).toBe('last before handover');
  });

  test('an account added in tab A survives tab B taking over and writing accounts', async () => {
    const browser = fakeBrowser();
    const a = bootTab(browser.makeTab());
    await a.claim();
    await a.out.client!.addAccount('main');
    const b = bootTab(browser.makeTab()); // opened now, inactive: no copy of anything
    await b.claim();
    await a.out.client!.addAccount('imported');
    expect(await b.takeOver()).toBe(true);
    await b.out.client!.addAccount('renamed');
    await expect(a.out.client!.addAccount('stale-copy')).rejects.toThrow(MOVED_ERROR);
    expect(Object.keys(browser.local('accounts')).sort()).toEqual(['imported', 'main', 'renamed']);
  });

  test('password change in tab A (new salt + re-keyed accounts) is not overwritten by tab B', async () => {
    const browser = fakeBrowser();
    const a = bootTab(browser.makeTab());
    await a.claim();
    await a.out.client!.set('salt', 'old-salt');
    await a.out.client!.set('accounts', { main: { encryptedKeys: 'under-old-key' } });
    const b = bootTab(browser.makeTab());
    expect(await b.claim()).toBe(false); // B cannot unlock or write anything while A is active
    await a.out.client!.set('salt', 'new-salt');
    await a.out.client!.set('accounts', { main: { encryptedKeys: 'under-new-key' } });
    expect(await b.takeOver()).toBe(true);
    expect(await b.out.client!.get('salt')).toBe('new-salt');
    expect(await b.out.client!.get('accounts')).toEqual({ main: { encryptedKeys: 'under-new-key' } });
  });

  test('a frozen old tab (hears nothing) is taken over after the wait, and its writes are refused when it wakes', async () => {
    const browser = fakeBrowser();
    const aTab = browser.makeTab();
    const a = bootTab(aTab);
    await a.claim();
    await a.out.client!.addAccount('main');
    aTab.freeze(); // no messages, no storage events, no lock-stolen notice
    const b = bootTab(browser.makeTab());
    expect(await b.takeOver()).toBe(true);
    await b.out.client!.addAccount('added-in-b');
    // A's hub still runs (it never heard anything): the owner record refuses its write anyway.
    await expect(a.out.client!.addAccount('stale')).rejects.toThrow(MOVED_ERROR);
    expect(a.out.webTab.state).toBe('lost');
    aTab.thaw();
    await tick(20);
    expect(Object.keys(browser.local('accounts')).sort()).toEqual(['added-in-b', 'main']);
    expect(b.out.webTab.isOwner()).toBe(true);
  });

  test('the old tab closed meanwhile: "Use here instead" takes over at once', async () => {
    const browser = fakeBrowser();
    const a = bootTab(browser.makeTab());
    await a.claim();
    const b = bootTab(browser.makeTab());
    await b.claim();
    // A closes: the browser releases its lock.
    a.out.webTab.onRelease(async () => undefined);
    (a.out.webTab as unknown as { letGo?: () => void }).letGo?.();
    await tick(5);
    const t0 = Date.now();
    expect(await b.takeOver()).toBe(true);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  test('the old tab never lets go and the new tab vanishes: the old tab reloads (and becomes active again)', async () => {
    const browser = fakeBrowser();
    const a = bootTab(browser.makeTab());
    await a.claim();
    // A takeover request from a tab that then closes before taking the lock.
    browser.makeTab().env.openChannel!()!.postMessage({ t: 'takeover', from: 'gone' });
    await tick(50);
    expect(a.out.worker).toBe('stopped');
    expect(a.out.webTab.state).toBe('releasing');
    await tick(400);
    expect(a.out.webTab.state).toBe('lost');
    expect(a.out.reloads).toBe(1);
    const again = bootTab(browser.makeTab()); // the reloaded page
    expect(await again.claim()).toBe(true);
  });

  describe('no Web Locks (old Safari)', () => {
    test('the first tab claims; a second tab stays inactive', async () => {
      const browser = fakeBrowser({ locks: false });
      const a = bootTab(browser.makeTab());
      const b = bootTab(browser.makeTab());
      expect(await a.claim()).toBe(true);
      expect(await b.claim()).toBe(false);
      expect(b.out.worker).toBe('never started');
    });

    test('fails closed: a record left by a tab that died is still "another tab"; takeover is offered and works', async () => {
      const browser = fakeBrowser({ locks: false });
      browser.items.set(WEB_TAB_OWNER_KEY, JSON.stringify({ id: 'crashed-tab', at: 0 }));
      const b = bootTab(browser.makeTab());
      expect(await b.claim()).toBe(false);
      expect(b.out.hub).toBeUndefined();
      expect(await b.takeOver()).toBe(true);
      expect(b.out.webTab.isOwner()).toBe(true);
    });

    test('fails closed: localStorage that cannot be read means inactive, and takeover is refused', async () => {
      const browser = fakeBrowser({ locks: false });
      const t = browser.makeTab();
      const b = bootTab({ ...t, env: { ...t.env, storage: undefined } });
      expect(await b.claim()).toBe(false);
      expect(await b.takeOver()).toBe(false);
      expect(b.out.hub).toBeUndefined();
    });

    test('a garbled owner record is treated as another tab', async () => {
      const browser = fakeBrowser({ locks: false });
      browser.items.set(WEB_TAB_OWNER_KEY, '{nope');
      const b = bootTab(browser.makeTab());
      expect(await b.claim()).toBe(false);
    });

    test('handover over storage events (no BroadcastChannel either): flushed, fenced, last writes seen', async () => {
      const browser = fakeBrowser({ locks: false, channel: false });
      const a = bootTab(browser.makeTab());
      expect(await a.claim()).toBe(true);
      await a.out.client!.addAccount('main');
      const inFlight = a.out.client!.addAccount('imported');
      const b = bootTab(browser.makeTab());
      expect(await b.claim()).toBe(false);
      expect(await b.takeOver()).toBe(true);
      await inFlight;
      await tick(30);
      expect(a.out.worker).toBe('stopped');
      expect(a.out.webTab.state).toBe('lost');
      await expect(a.out.client!.addAccount('stale')).rejects.toThrow(MOVED_ERROR);
      await b.out.client!.addAccount('renamed');
      expect(Object.keys(browser.local('accounts')).sort()).toEqual(['imported', 'main', 'renamed']);
    });

    test('a closing active tab clears its record, so the next tab starts by itself', async () => {
      const browser = fakeBrowser({ locks: false });
      const a = bootTab(browser.makeTab());
      await a.claim();
      a.out.webTab.onPageHide();
      const b = bootTab(browser.makeTab());
      expect(await b.claim()).toBe(true);
    });
  });

  test('the owner record cleared under the active tab (site data) is written again, not treated as a takeover', async () => {
    const browser = fakeBrowser();
    const a = bootTab(browser.makeTab());
    await a.claim();
    browser.items.delete(WEB_TAB_OWNER_KEY);
    await a.out.client!.set('k', 1);
    expect(browser.local('k')).toBe(1);
    expect(a.out.webTab.state).toBe('active');
  });

  describe('extension, phones and Desktop are unaffected', () => {
    test('only the web edition runs the one-tab gate', () => {
      expect(isWebEdition({ native: false, tauri: false })).toBe(true);
      expect(isWebEdition({ native: true, tauri: false })).toBe(false);
      expect(isWebEdition({ native: false, tauri: true })).toBe(false);
    });

    test('main.ts: the gate runs before the hub, the worker and the UI, and only on the web; Desktop keeps its backend', () => {
      const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
      const gate = src.indexOf(
        'isWebEdition({ native: Capacitor.isNativePlatform(), tauri: IS_TAURI })\n  ? await startWebTab()\n  : undefined',
      );
      expect(gate).toBeGreaterThan(0);
      expect(gate).toBeLessThan(src.indexOf('new Hub('));
      expect(gate).toBeLessThan(src.indexOf('new Worker('));
      expect(gate).toBeLessThan(src.indexOf("await import('../index')"));
      expect(gate).toBeLessThan(src.indexOf('startBootWatchdog();'));
      expect(src).toContain(
        'IS_TAURI ? tauriLocalBackend(tauriInvoke) : webTab ? fencedBackend(nativeLocalBackend, webTab) : undefined',
      );
      // The release hook is set in the same synchronous run as the hub and worker (no await between).
      const between = src.slice(src.indexOf('new Hub('), src.indexOf('webTab?.onRelease('));
      expect(between).not.toMatch(/\bawait\b/);
    });

    test('nothing but main.ts uses the gate (the extension’s entry points never load it)', () => {
      const root = new URL('..', import.meta.url).pathname;
      const users: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const p = join(dir, name);
          if (statSync(p).isDirectory()) walk(p);
          else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !p.endsWith('webTab.ts')) {
            if (/from '\.\/webTab'|from '\.\.\/webTab'|mobile\/webTab'/.test(readFileSync(p, 'utf8'))) users.push(p);
          }
        }
      };
      walk(root);
      expect(users.map((p) => p.slice(root.length))).toEqual(['mobile/main.ts']);
    });
  });
});

/** Just enough DOM for showInactiveScreen. */
function fakeDocument() {
  type El = {
    tag: string;
    textContent: string;
    style: { cssText: string };
    disabled: boolean;
    type: string;
    id: string;
    children: El[];
    parent?: El;
    listeners: Array<() => void>;
    setAttribute: () => void;
    append: (...els: El[]) => void;
    appendChild: (el: El) => void;
    addEventListener: (t: string, fn: () => void) => void;
    remove: () => void;
  };
  const el = (tag: string): El => {
    const e: El = {
      tag,
      textContent: '',
      style: { cssText: '' },
      disabled: false,
      type: '',
      id: '',
      children: [],
      listeners: [],
      setAttribute: () => undefined,
      append: (...els) => els.forEach((c) => e.appendChild(c)),
      appendChild: (c) => {
        c.parent = e;
        e.children.push(c);
      },
      addEventListener: (_t, fn) => void e.listeners.push(fn),
      remove: () => {
        if (e.parent) e.parent.children = e.parent.children.filter((c) => c !== e);
      },
    };
    return e;
  };
  const body = el('body');
  const all = (e: El): El[] => [e, ...e.children.flatMap(all)];
  return {
    body,
    createElement: el,
    text: () =>
      all(body)
        .map((e) => e.textContent)
        .join(' | '),
    click: (label: string) =>
      all(body)
        .find((e) => e.textContent === label)
        ?.listeners.forEach((fn) => fn()),
  };
}
