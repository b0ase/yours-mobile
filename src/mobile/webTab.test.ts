/**
 * Web wallet, one active tab (13 Nov 2026). Each tab of web.bwalletx.com ran its own Hub (a copy of localStorage
 * loaded at start-up) and its own background worker, and wrote its whole stale copy back: an account imported in one
 * tab was removed by the other's next write. These tests open several "tabs" over one fake browser (shared
 * localStorage, Web Locks with query(), BroadcastChannel and storage events) and check only one of them ever runs the
 * wallet, including when localStorage is full and when a woken tab reads a stale copy of localStorage.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Hub, type LocalBackend } from './hub';
import {
  fencedBackend,
  freeDisposableCaches,
  isDisposableCacheKey,
  isFreshWebKey,
  isWebEdition,
  MOVED_ERROR,
  SpendGauge,
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
const quotaError = () => Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });

/** One browser profile: one localStorage, one lock manager, one channel bus, shared by every tab. */
const fakeBrowser = (opts: { locks?: boolean; query?: boolean; channel?: boolean; quotaFull?: boolean } = {}) => {
  const items = new Map<string, string>();
  const quota = { full: !!opts.quotaFull };
  type TabIo = {
    clientId: string;
    frozen: boolean;
    /** A woken tab's renderer still serving its old copy of localStorage. */
    stale?: Map<string, string>;
    storageListeners: Array<(e: { key: string | null; newValue: string | null }) => void>;
    channelListeners: Array<(e: { data: unknown }) => void>;
    deferred: Array<() => void>;
  };
  const tabs: TabIo[] = [];
  const deliver = (io: TabIo, fn: () => void) => setTimeout(() => (io.frozen ? io.deferred.push(fn) : fn()), 0);

  type Held = { name: string; io: TabIo; reject: (e: Error) => void; done: boolean };
  const held = new Map<string, Held>();

  const makeTab = () => {
    const io: TabIo = {
      clientId: `client-${tabs.length}`,
      frozen: false,
      storageListeners: [],
      channelListeners: [],
      deferred: [],
    };
    tabs.push(io);
    const notify = (key: string, newValue: string | null) => {
      for (const other of tabs)
        if (other !== io) for (const l of other.storageListeners) deliver(other, () => l({ key, newValue }));
    };
    const view = () => io.stale ?? items;
    const storage: StorageLike = {
      getItem: (k) => view().get(k) ?? null,
      setItem: (k, v) => {
        if (quota.full && !items.has(k)) throw quotaError();
        items.set(k, v);
        io.stale?.set(k, v);
        notify(k, v);
      },
      removeItem: (k) => {
        items.delete(k);
        io.stale?.delete(k);
        notify(k, null);
      },
    };
    const locks: LockManagerLike = {
      request: (name, o, cb) => {
        const cur = held.get(name);
        if (cur && !cur.done && o.ifAvailable) return Promise.resolve(cb(null));
        if (cur && !cur.done && !o.steal) return Promise.reject(new Error('queued requests not modelled'));
        if (cur && !cur.done && o.steal) {
          cur.done = true;
          const err = Object.assign(new Error('stolen'), { name: 'AbortError' });
          deliver(cur.io, () => cur.reject(err));
        }
        return new Promise((resolve, reject) => {
          const entry: Held = { name, io, reject, done: false };
          held.set(name, entry);
          void Promise.resolve(cb({ name })).then((v) => {
            if (entry.done) return;
            entry.done = true;
            if (held.get(name) === entry) held.delete(name);
            resolve(v);
          });
        });
      },
      // The browser process answers: never a renderer's stale copy.
      ...(opts.query === false
        ? {}
        : {
            query: async () => ({
              held: [...held.values()].filter((h) => !h.done).map((h) => ({ name: h.name, clientId: h.io.clientId })),
            }),
          }),
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
      freeSpace: () => {
        const removed = freeDisposableCaches({
          get length() {
            return items.size;
          },
          key: (i) => [...items.keys()][i] ?? null,
          removeItem: (k) => void items.delete(k),
        });
        if (removed > 0) quota.full = false;
        return removed;
      },
      newId: () => `tab-${tabs.indexOf(io)}-${++n}`,
      now: () => Date.now(),
      claimRetryMs: [],
      takeoverWaitMs: 60,
      busyWaitMs: 1000,
      flushWaitMs: 200,
      releaseWaitMs: 1500,
      stealWaitMs: 300,
      claimSettleMs: 10,
    };
    /** storage.local the way the web fallback keeps it (native.ts): `secure:` items, read through this tab's view. */
    const backend: LocalBackend = {
      load: async () =>
        Object.fromEntries([...view()].filter(([k]) => k.startsWith('secure:')).map(([k, v]) => [k.slice(7), v])),
      apply: async (sets, removes) => {
        for (const [k, v] of Object.entries(sets)) storage.setItem(`secure:${k}`, v);
        for (const k of removes) storage.removeItem(`secure:${k}`);
      },
      loadKeys: async (keys) => Object.fromEntries(keys.map((k) => [k, storage.getItem(`secure:${k}`)])),
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
      /** From now on this tab reads the localStorage it last saw. */
      goStale: () => void (io.stale = new Map(items)),
    };
  };
  const local = (key: string) => {
    const raw = items.get(`secure:chrome.storage.local:${key}`);
    return raw === undefined ? undefined : JSON.parse(raw);
  };
  return { items, quota, makeTab, local };
};

type FakeTab = ReturnType<ReturnType<typeof fakeBrowser>['makeTab']>;

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
  /** ChromeStorageService.updateNested('accounts', …): read, merge, write the whole map back. */
  const addAccount = async (id: string) => {
    const accounts = ((await get('accounts')) ?? {}) as Record<string, unknown>;
    await set('accounts', { ...accounts, [id]: { name: id } });
  };
  return { get, set, addAccount };
};

/** main.ts for the web, in miniature: claim, and only then build the hub and start the worker. */
const bootTab = (tab: FakeTab, opts: { fresh?: boolean } = {}) => {
  const webTab = new WebTab(tab.env);
  const spends = new SpendGauge();
  const out = {
    webTab,
    spends,
    hub: undefined as Hub | undefined,
    client: undefined as ReturnType<typeof hubClient> | undefined,
    worker: 'never started' as 'never started' | 'running' | 'stopped',
    stoppedAt: 0,
    reloads: 0,
  };
  const startWallet = () => {
    const hub = new Hub(async () => undefined, fencedBackend(tab.backend, webTab), {
      persistSession: false,
      freshLocalKeys: opts.fresh === false ? undefined : isFreshWebKey,
    });
    out.hub = hub;
    out.client = hubClient(hub);
    out.worker = 'running';
    webTab.onRelease(async (tell) => {
      if (spends.count > 0) {
        tell('payment');
        await spends.idle(1000);
      }
      hub.fence();
      await hub.flush();
      out.worker = 'stopped';
      out.stoppedAt = Date.now();
    });
    webTab.onLost(() => void out.reloads++);
  };
  return {
    out,
    claim: async () => {
      if (await webTab.claim()) startWallet();
      return webTab.state === 'active';
    },
    takeOver: async (onProgress?: (p: 'payment') => void) => {
      const ok = await webTab.takeOver(onProgress);
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
    await hubA.addAccount('imported');
    await hubB.addAccount('renamed'); // B's copy is from start-up
    expect(Object.keys(browser.local('accounts'))).not.toContain('imported');
  });

  test('two tabs: the second never becomes active, never builds a hub, never starts the worker', async () => {
    const browser = fakeBrowser();
    const a = bootTab(browser.makeTab());
    const b = bootTab(browser.makeTab());
    expect(await a.claim()).toBe(true);
    expect(await b.claim()).toBe(false);
    expect(b.out.webTab.blocked).toBe('other-tab');
    expect(b.out.hub).toBeUndefined();
    expect(b.out.worker).toBe('never started');
    expect(await b.out.webTab.stillOwner()).toBe(false);
    expect(await a.out.webTab.stillOwner()).toBe(true);
    await tick(20);
    expect(a.out.webTab.state).toBe('active');
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
    expect(doc.body.children.length).toBe(0);
    await tick(20);
    expect(a.out.webTab.state).toBe('lost');
    expect(a.out.reloads).toBe(1);
  });

  test('takeover: the old tab flushes and stops; its later writes are refused; the new tab sees its last writes', async () => {
    const browser = fakeBrowser();
    const a = bootTab(browser.makeTab());
    await a.claim();
    await a.out.client!.set('note', 'first');
    const lastWrite = a.out.client!.set('note', 'last before handover');
    const b = bootTab(browser.makeTab());
    expect(await b.claim()).toBe(false);
    expect(await b.takeOver()).toBe(true);
    await lastWrite;
    expect(a.out.worker).toBe('stopped');
    await tick(20);
    expect(a.out.webTab.state).toBe('lost');
    expect(a.out.reloads).toBe(1);
    await expect(a.out.client!.set('note', 'stale')).rejects.toThrow(MOVED_ERROR);
    expect(browser.local('note')).toBe('last before handover');
    expect(await b.out.client!.get('note')).toBe('last before handover');
  });

  test('an account added in tab A survives tab B taking over and writing accounts', async () => {
    const browser = fakeBrowser();
    const a = bootTab(browser.makeTab());
    await a.claim();
    await a.out.client!.addAccount('main');
    const b = bootTab(browser.makeTab());
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
    expect(await b.claim()).toBe(false);
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
    aTab.freeze();
    const b = bootTab(browser.makeTab());
    expect(await b.takeOver()).toBe(true);
    await b.out.client!.addAccount('added-in-b');
    await expect(a.out.client!.addAccount('stale')).rejects.toThrow(MOVED_ERROR);
    expect(a.out.webTab.state).toBe('lost');
    aTab.thaw();
    await tick(20);
    expect(Object.keys(browser.local('accounts')).sort()).toEqual(['added-in-b', 'main']);
    expect(await b.out.webTab.stillOwner()).toBe(true);
  });

  test('finding 2a: a woken tab that reads a STALE localStorage (its own id still in the owner record) is refused by the lock query', async () => {
    const browser = fakeBrowser();
    const aTab = browser.makeTab();
    const a = bootTab(aTab, { fresh: false });
    await a.claim();
    await a.out.client!.addAccount('main');
    aTab.freeze(); // no messages, no storage events, no lock-stolen notice
    aTab.goStale(); // and its renderer keeps serving the localStorage it last saw
    const b = bootTab(browser.makeTab());
    expect(await b.takeOver()).toBe(true);
    await b.out.client!.addAccount('added-in-b');
    // A's view still names A as owner: only the browser-side lock state can tell it lost.
    expect(JSON.parse(aTab.env.storage!.getItem(WEB_TAB_OWNER_KEY)!).id).toBe(a.out.webTab.id);
    await expect(a.out.client!.addAccount('stale')).rejects.toThrow(MOVED_ERROR);
    expect(Object.keys(browser.local('accounts')).sort()).toEqual(['added-in-b', 'main']);
    expect(a.out.webTab.state).toBe('lost');
  });

  test('finding 2b: accounts and key material are re-read from localStorage on every read-merge-write', async () => {
    const browser = fakeBrowser();
    const t = browser.makeTab();
    const a = bootTab(t);
    await a.claim();
    await a.out.client!.addAccount('main');
    // Written behind this hub's back (another writer of the same localStorage).
    browser.items.set('secure:chrome.storage.local:accounts', JSON.stringify({ main: {}, other: {} }));
    browser.items.set('secure:chrome.storage.local:salt', JSON.stringify('salt-2'));
    await a.out.client!.addAccount('third');
    expect(Object.keys(browser.local('accounts')).sort()).toEqual(['main', 'other', 'third']);
    expect(await a.out.client!.get('salt')).toBe('salt-2');
    for (const k of ['accounts', 'salt', 'keyRekey', 'keyEpoch', 'keyRecovery', 'kdfPending'])
      expect(isFreshWebKey(k)).toBe(true);
    expect(isFreshWebKey('bwxStreamGrants')).toBe(false);
  });

  test('the old tab closed meanwhile: "Use here instead" takes over at once', async () => {
    const browser = fakeBrowser();
    const a = bootTab(browser.makeTab());
    await a.claim();
    const b = bootTab(browser.makeTab());
    await b.claim();
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
    browser.makeTab().env.openChannel!()!.postMessage({ t: 'takeover', from: 'gone' });
    await tick(50);
    expect(a.out.worker).toBe('stopped');
    expect(a.out.webTab.state).toBe('releasing');
    await tick(400);
    expect(a.out.webTab.state).toBe('lost');
    expect(a.out.reloads).toBe(1);
    const again = bootTab(browser.makeTab());
    expect(await again.claim()).toBe(true);
  });

  describe('finding 1: a full localStorage never locks the wallet out', () => {
    test('Web Locks: the held lock is the authority; the tab starts although the owner record cannot be written', async () => {
      const browser = fakeBrowser({ quotaFull: true });
      const a = bootTab(browser.makeTab());
      expect(await a.claim()).toBe(true);
      expect(a.out.webTab.recordPending).toBe(true);
      expect(browser.items.has(WEB_TAB_OWNER_KEY)).toBe(false);
      // Space comes back: the next write records the owner.
      browser.quota.full = false;
      await a.out.client!.set('k', 1);
      expect(a.out.webTab.recordPending).toBe(false);
      expect(JSON.parse(browser.items.get(WEB_TAB_OWNER_KEY)!).id).toBe(a.out.webTab.id);
      // A second tab is still held back by the lock.
      const b = bootTab(browser.makeTab());
      expect(await b.claim()).toBe(false);
      expect(b.out.webTab.blocked).toBe('other-tab');
    });

    test('takeover works with a full localStorage too (reviewer probe P1)', async () => {
      const browser = fakeBrowser();
      const a = bootTab(browser.makeTab());
      await a.claim();
      browser.quota.full = true;
      const b = bootTab(browser.makeTab());
      expect(await b.takeOver()).toBe(true);
      expect(a.out.webTab.state).not.toBe('active');
    });

    test('known caches are dropped to make room for the owner record; wallet data is untouched', async () => {
      const browser = fakeBrowser({ quotaFull: true });
      browser.items.set('bwallet:list-cache:tokens', '[1,2,3]');
      browser.items.set('bwallet:thread-cache', '[]');
      browser.items.set('bwallet.avatar.abc', 'data:image/png;base64,AAAA');
      browser.items.set('secure:chrome.storage.local:accounts', '{"main":{}}');
      const a = bootTab(browser.makeTab());
      expect(await a.claim()).toBe(true);
      expect(a.out.webTab.recordPending).toBe(false);
      expect(browser.items.has('bwallet:list-cache:tokens')).toBe(false);
      expect(browser.items.has('bwallet:thread-cache')).toBe(false);
      expect(browser.items.get('bwallet.avatar.abc')).toBe('data:image/png;base64,AAAA');
      expect(browser.local('accounts')).toEqual({ main: {} });
    });

    test('no Web Locks + full storage: a distinct "storage full" screen, never "open in another tab"', async () => {
      const browser = fakeBrowser({ locks: false, quotaFull: true });
      const doc = fakeDocument();
      void startWebTab(browser.makeTab().env, doc as unknown as Document);
      await tick(40);
      expect(doc.text()).toContain('storage for bWalletX is full');
      expect(doc.text()).toContain('don’t clear this site’s data');
      expect(doc.text()).not.toContain('open in another tab');
      browser.quota.full = false;
      doc.click('Try again');
      await tick(60);
      expect(doc.body.children.length).toBe(0);
    });

    test('finding 5: unreadable localStorage gets its own message, not "open in another tab"', async () => {
      const browser = fakeBrowser();
      const doc = fakeDocument();
      void startWebTab({ ...browser.makeTab().env, storage: undefined }, doc as unknown as Document);
      await tick(20);
      expect(doc.text()).toContain('can’t use this browser’s storage');
      expect(doc.text()).not.toContain('open in another tab');
    });

    test('only caches count as disposable', () => {
      for (const k of [
        'bwallet:list-cache:x',
        'bwallet:thread-cache',
        'bwallet.chatAvatarPublished.bob',
        'bwx.diag.syncLog',
      ])
        expect(isDisposableCacheKey(k)).toBe(true);
      for (const k of [
        'secure:chrome.storage.local:accounts',
        'bwallet.avatar.abc',
        WEB_TAB_OWNER_KEY,
        'bwx-store-outbox:k',
      ])
        expect(isDisposableCacheKey(k)).toBe(false);
    });
  });

  describe('finding 3: a payment in flight finishes before the handover', () => {
    test('the old tab waits for the payment, the new tab says so and keeps waiting past its usual wait', async () => {
      const browser = fakeBrowser();
      const a = bootTab(browser.makeTab());
      await a.claim();
      a.out.spends.set(1); // a createAction is running in A's worker
      const b = bootTab(browser.makeTab());
      const progress: string[] = [];
      let paymentDoneAt = 0;
      setTimeout(() => {
        paymentDoneAt = Date.now();
        a.out.spends.set(0);
      }, 250); // longer than takeoverWaitMs (60 ms)
      expect(await b.takeOver((p) => progress.push(p))).toBe(true);
      expect(progress).toEqual(['payment']);
      expect(paymentDoneAt).toBeGreaterThan(0);
      expect(a.out.stoppedAt).toBeGreaterThanOrEqual(paymentDoneAt); // the worker was not cut off mid-payment
    });

    test('a payment that never ends: the handover goes ahead after the limit', async () => {
      const browser = fakeBrowser();
      const a = bootTab(browser.makeTab());
      await a.claim();
      a.out.spends.set(1);
      const b = bootTab(browser.makeTab());
      expect(await b.takeOver()).toBe(true); // A's gauge waits 1000 ms in this test, B's busy wait 1000 ms
      expect(a.out.worker).toBe('stopped');
    });

    test('SpendGauge: idle() resolves when the count drops to zero, or false after the limit', async () => {
      const g = new SpendGauge();
      expect(await g.idle(10)).toBe(true);
      g.set(2);
      const p = g.idle(500);
      g.set(0);
      expect(await p).toBe(true);
      g.set(1);
      expect(await g.idle(20)).toBe(false);
    });

    test('main.ts waits for running payments before fencing; the worker reports them; initWallet counts them', () => {
      const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
      const hook = main.slice(main.indexOf('webTab?.onRelease('));
      expect(hook.indexOf('await spends.idle(PAYMENT_HANDOVER_WAIT_MS)')).toBeGreaterThan(0);
      expect(hook.indexOf('await spends.idle(')).toBeLessThan(hook.indexOf('hub.fence()'));
      expect(hook.indexOf('hub.fence()')).toBeLessThan(hook.indexOf('worker.terminate()'));
      expect(main).toContain("e.data?.t === 'spends'");
      const worker = readFileSync(new URL('./background.worker.ts', import.meta.url), 'utf8');
      expect(worker).toContain("onSpendsInFlight((n) => self.postMessage({ t: 'spends', n }))");
      const init = readFileSync(new URL('../initWallet.ts', import.meta.url), 'utf8');
      expect(init.indexOf('trackSpendsInFlight(baseWallet)')).toBeGreaterThan(
        init.indexOf('guardSpending(baseWallet)'),
      );
    });
  });

  test('finding 4: two tabs press "Use here instead" at once: one takes over, the other is told to retry, no flip', async () => {
    const browser = fakeBrowser();
    const a = bootTab(browser.makeTab());
    await a.claim();
    const b = bootTab(browser.makeTab());
    const c = bootTab(browser.makeTab());
    const [okB, okC] = await Promise.all([b.takeOver(), c.takeOver()]);
    expect([okB, okC].filter(Boolean).length).toBe(1);
    const [winner, loser] = okB ? [b, c] : [c, b];
    expect(loser.out.webTab.blocked).toBe('busy');
    expect(loser.out.worker).toBe('never started');
    await tick(400);
    expect(winner.out.webTab.state).toBe('active');
    expect(winner.out.reloads).toBe(0);
    expect(a.out.webTab.state).toBe('lost');
  });

  test('finding 5: a reload racing the old page retries the lock before showing the screen', async () => {
    const browser = fakeBrowser();
    const a = bootTab(browser.makeTab());
    await a.claim();
    const t = browser.makeTab();
    const b = bootTab({ ...t, env: { ...t.env, claimRetryMs: [30, 60] } });
    setTimeout(() => (a.out.webTab as unknown as { letGo?: () => void }).letGo?.(), 20); // the old page unloads
    expect(await b.claim()).toBe(true);
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
      expect(await b.out.webTab.stillOwner()).toBe(true);
    });

    test('fails closed: localStorage that cannot be read means inactive, and takeover is refused', async () => {
      const browser = fakeBrowser({ locks: false });
      const t = browser.makeTab();
      const b = bootTab({ ...t, env: { ...t.env, storage: undefined } });
      expect(await b.claim()).toBe(false);
      expect(b.out.webTab.blocked).toBe('no-storage');
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

    test('two tabs pressing at once: one takes over, the other is told to retry', async () => {
      const browser = fakeBrowser({ locks: false });
      const a = bootTab(browser.makeTab());
      await a.claim();
      const b = bootTab(browser.makeTab());
      const c = bootTab(browser.makeTab());
      const [okB, okC] = await Promise.all([b.takeOver(), c.takeOver()]);
      expect([okB, okC].filter(Boolean).length).toBe(1);
    });
  });

  test('Web Locks without query(): an older owner record left behind does not retire the tab; a newer one does', async () => {
    const browser = fakeBrowser({ query: false });
    browser.items.set(WEB_TAB_OWNER_KEY, JSON.stringify({ id: 'old-tab', at: 1 }));
    browser.quota.full = true; // so the claim cannot overwrite it
    const a = bootTab(browser.makeTab());
    expect(await a.claim()).toBe(true);
    browser.quota.full = false;
    await a.out.client!.set('k', 1);
    expect(browser.local('k')).toBe(1);
    browser.items.set(WEB_TAB_OWNER_KEY, JSON.stringify({ id: 'new-tab', at: Date.now() + 1000 }));
    await expect(a.out.client!.set('k', 2)).rejects.toThrow(MOVED_ERROR);
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
      // The key material is re-read on the web (a merge with fix/envelope-queue ORs its envelope predicate in here).
      const hubCall = src.slice(src.indexOf('new Hub('), src.indexOf(');', src.indexOf('new Hub(')));
      expect(hubCall).toMatch(/freshLocalKeys: webTab \? [^\n]*isFreshWebKey/);
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
