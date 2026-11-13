/**
 * Web wallet, two tabs (13 Nov 2026). Each tab of web.bwalletx.com runs its own Hub and background worker over the
 * same localStorage, and a Hub loads storage.local into memory once at start-up. An envelope balance read from that
 * copy goes stale as soon as the other tab spends, so a site framed in both tabs could spend the same balance twice.
 * With freshLocalKeys the envelope key is re-read from localStorage on every get/set, and the envelope lock
 * (withEnvelopeLock: navigator.locks across tabs, a module queue here) keeps the read-check-write in one piece.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Hub, type LocalBackend } from './hub';
import {
  ENVELOPES_KEY_PREFIX,
  EnvelopeStore,
  type EnvelopeBackend,
  type EnvelopeState,
} from '../services/envelopes';

const SITE = 'www.bchatx.com';
const KEY = `${ENVELOPES_KEY_PREFIX}acct`;
const PREFIXED = `chrome.storage.local:${KEY}`;

/** One browser's localStorage (the `secure:` items the web fallback writes), shared by every tab's hub. */
const browserStorage = (initial: Record<string, string> = {}) => {
  const items = new Map(Object.entries(initial));
  let failReads = false;
  const backend: LocalBackend = {
    load: async () => Object.fromEntries(items),
    apply: async (sets, removes) => {
      for (const [k, v] of Object.entries(sets)) items.set(k, v);
      for (const k of removes) items.delete(k);
    },
    loadKeys: async (keys) => {
      if (failReads) throw new Error('localStorage unavailable');
      return Object.fromEntries(keys.map((k) => [k, items.get(k) ?? null]));
    },
  };
  return { backend, items, failReads: (on: boolean) => (failReads = on) };
};

const filled = (sats: number): string =>
  JSON.stringify({
    envelopes: {
      [SITE]: { originator: SITE, balanceSats: sats, createdAt: 1, updatedAt: 1, filledSats: sats, spentSats: 0, history: [] },
    },
  } satisfies EnvelopeState);

/** A tab: its own hub, and its background's envelope backend talking to that hub as chrome.storage.local does. */
const openTab = (backend: LocalBackend, fresh: boolean, opts: { badFrame?: boolean } = {}) => {
  const hub = new Hub(async () => undefined, backend, {
    persistSession: false,
    freshLocalKeys: fresh ? (k) => k.startsWith(ENVELOPES_KEY_PREFIX) : undefined,
  });
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
  // A frame whose window went away: posting to it throws (review F1).
  if (opts.badFrame)
    hub.register('frame-1', {
      sender: { id: 'x', url: 'http://yours-mobile/popup.html', origin: 'http://yours-mobile' },
      post: () => {
        throw new Error('detached frame');
      },
    });
  const storage = (op: 'get' | 'set', arg: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++reqId;
      waiting.set(id, { resolve, reject });
      void hub.handle('background', { t: 'storage', reqId: id, area: 'local', op, arg } as never);
    });
  const envelopeBackend: EnvelopeBackend = {
    key: KEY,
    load: async () => ((await storage('get', KEY)) as Record<string, unknown>)[KEY],
    save: async (state) => void (await storage('set', { [KEY]: state })),
  };
  return { hub, storage, store: new EnvelopeStore(envelopeBackend, Date.now, { timeoutMs: 500 }) };
};

const storedBalance = (items: Map<string, string>) =>
  (JSON.parse(items.get(PREFIXED) ?? '{"envelopes":{}}') as EnvelopeState).envelopes[SITE]?.balanceSats ?? 0;

describe('web wallet: two tabs never spend one envelope balance twice', () => {
  // The hub reads sessionStorage at construction (a page global); give it one for these tests only.
  const g = globalThis as { sessionStorage?: unknown };
  const hadSession = 'sessionStorage' in g;
  beforeAll(() => {
    if (!hadSession) g.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  });
  afterAll(() => {
    if (!hadSession) delete g.sessionStorage;
  });

  test('control (the bug): a hub that trusts its start-up copy lets the second tab spend a balance already spent', async () => {
    const browser = browserStorage({ [PREFIXED]: filled(100) });
    const a = openTab(browser.backend, false);
    const b = openTab(browser.backend, false);
    expect(await a.store.trySpend(SITE, 100)).toBe(true);
    expect(await b.store.trySpend(SITE, 100)).toBe(true); // 200 sats out of a 100 sat envelope
  });

  test('tab A spends the balance, then tab B (copy loaded before) is refused', async () => {
    const browser = browserStorage({ [PREFIXED]: filled(100) });
    const a = openTab(browser.backend, true);
    const b = openTab(browser.backend, true);
    expect(await a.store.trySpend(SITE, 100)).toBe(true);
    expect(await b.store.trySpend(SITE, 100)).toBe(false);
    expect(storedBalance(browser.items)).toBe(0);
  });

  test('both tabs racing for the last sats: exactly one passes', async () => {
    for (let i = 0; i < 20; i++) {
      const browser = browserStorage({ [PREFIXED]: filled(100) });
      const a = openTab(browser.backend, true);
      const b = openTab(browser.backend, true);
      const [x, y] = await Promise.all([a.store.trySpend(SITE, 100), b.store.trySpend(SITE, 100)]);
      expect(Number(x) + Number(y)).toBe(1);
      expect(storedBalance(browser.items)).toBe(0);
    }
  });

  test('many small payments split across tabs never exceed the balance', async () => {
    const browser = browserStorage({ [PREFIXED]: filled(255) });
    const tabs = [openTab(browser.backend, true), openTab(browser.backend, true), openTab(browser.backend, true)];
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => tabs[i % 3].store.trySpend(SITE, 10)));
    expect(results.filter(Boolean).length).toBe(25);
    expect(storedBalance(browser.items)).toBe(5);
  });

  test('Coin return in one tab: the other tab cannot spend the closed envelope', async () => {
    const browser = browserStorage({ [PREFIXED]: filled(100) });
    const a = openTab(browser.backend, true);
    const b = openTab(browser.backend, true);
    expect(await a.store.close(SITE)).toBe(100);
    expect(await b.store.trySpend(SITE, 1)).toBe(false);
    expect(storedBalance(browser.items)).toBe(0);
  });

  test('localStorage cannot be read: the payment is refused, not answered from the tab copy', async () => {
    const browser = browserStorage({ [PREFIXED]: filled(100) });
    const a = openTab(browser.backend, true);
    await a.store.get(SITE); // the hub has its copy
    browser.failReads(true);
    await expect(a.store.trySpend(SITE, 1)).rejects.toThrow('localStorage unavailable');
    browser.failReads(false);
    expect(storedBalance(browser.items)).toBe(100);
  });

  test('main.ts re-reads envelope keys on the web only (phones and Desktop have one hub)', () => {
    const src = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    expect(src).toContain(
      'freshLocalKeys:\n    !Capacitor.isNativePlatform() && !IS_TAURI ? (key) => key.startsWith(ENVELOPES_KEY_PREFIX) : undefined',
    );
  });

  // The reviewer's probe (env-review/probe/probe.test.ts), as a repo test.
  test('F1: a frame that throws on post never stops the reply, so the envelope lock is never held for ever', async () => {
    const browser = browserStorage({ [PREFIXED]: filled(100) });
    const a = openTab(browser.backend, true, { badFrame: true });
    const b = openTab(browser.backend, true);
    await a.store.get(SITE); // tab A's copy loaded
    expect(await b.store.trySpend(SITE, 10)).toBe(true); // tab B writes: A's next read broadcasts what it saw
    const settle = <T>(p: Promise<T>) =>
      Promise.race([p, new Promise<'TIMEOUT'>((r) => setTimeout(() => r('TIMEOUT'), 300))]);
    expect(await settle(a.store.trySpend(SITE, 10))).toBe(true);
    expect(await settle(b.store.trySpend(SITE, 10))).toBe(true);
    expect(storedBalance(browser.items)).toBe(70);
  });

  test('F6: get(null) sees an envelope key another tab created after this tab loaded', async () => {
    const browser = browserStorage();
    const a = openTab(browser.backend, true);
    const b = openTab(browser.backend, true);
    await a.storage('get', null); // A loaded with no envelopes
    await b.store.fill(SITE, 100);
    const all = (await a.storage('get', null)) as Record<string, EnvelopeState>;
    expect(all[KEY]?.envelopes[SITE]?.balanceSats).toBe(100);
  });
});

