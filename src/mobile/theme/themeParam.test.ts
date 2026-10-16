import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { applyAccent, applyThemeParam, packFromThemeParam, swapInstallLinks, switchToAccountAccent } from './accent';

const store = new Map<string, string>();
let href = 'https://web.bwalletx.com/';
const replaced: string[] = [];
const g = globalThis as Record<string, unknown>;
const saved = { localStorage: g.localStorage, window: g.window };
afterAll(() => {
  applyAccent('gold');
  g.localStorage = saved.localStorage;
  g.window = saved.window;
});
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
g.window = {
  get location() {
    return { href };
  },
  history: {
    state: null,
    replaceState: (_s: unknown, _t: string, u: string) => {
      replaced.push(u);
      href = new URL(u, href).href;
    },
  },
  dispatchEvent: () => true,
};

beforeEach(() => {
  store.clear();
  replaced.length = 0;
});

describe('?theme links', () => {
  test('maps names to packs', () => {
    expect(packFromThemeParam('white')).toBe('white');
    expect(packFromThemeParam('WHITE')).toBe('white');
    expect(packFromThemeParam('gold')).toBe('gold');
    expect(packFromThemeParam('dark')).toBe('gold');
    expect(packFromThemeParam('paper')).toBe('white');
    expect(packFromThemeParam('nope')).toBeNull();
    expect(packFromThemeParam('silver')).toBeNull();
  });

  test('applies once, strips the param, keeps other params', () => {
    href = 'https://web.bwalletx.com/?theme=white&x=1#h';
    expect(applyThemeParam()).toBe('white');
    expect(replaced).toEqual(['/?x=1#h']);
    expect(store.get('bwx.accent.boot')).toBe('white');
    // the user picks another theme; the same link again must not override it
    store.set('bwx.accent.boot', 'cyber');
    href = 'https://web.bwalletx.com/?theme=white';
    expect(applyThemeParam()).toBeNull();
    expect(store.get('bwx.accent.boot')).toBe('cyber');
    expect(replaced[1]).toBe('/');
  });

  test('ignores unknown values but still strips them', () => {
    href = 'https://web.bwalletx.com/?theme=bogus';
    expect(applyThemeParam()).toBeNull();
    expect(store.has('bwx.accent.boot')).toBe(false);
    expect(replaced).toEqual(['/']);
  });

  test('no param: nothing happens', () => {
    href = 'https://web.bwalletx.com/';
    expect(applyThemeParam()).toBeNull();
    expect(replaced).toEqual([]);
  });

  test("pending link theme becomes the opened account's choice", () => {
    store.set('bwx.accent.acct1', 'cyber');
    href = 'https://web.bwalletx.com/?theme=white';
    applyThemeParam();
    expect(switchToAccountAccent('acct1')).toBe('white');
    expect(store.get('bwx.accent.acct1')).toBe('white');
    expect(store.has('bwx.accent.pending')).toBe(false);
    // later the account's own choice wins again
    store.set('bwx.accent.acct1', 'cyber');
    expect(switchToAccountAccent('acct1')).toBe('cyber');
  });
});

describe('themed installs', () => {
  test('only linked colours swap', () => {
    const links: Record<string, string> = {
      manifest: '/manifest.webmanifest',
      'apple-touch-icon': '/icons/icon192.png',
    };
    const prev = g.document;
    g.document = {
      querySelector: (sel: string) => {
        const rel = /rel="([^"]+)"/.exec(sel)?.[1] ?? '';
        return rel in links ? { setAttribute: (_: string, v: string) => (links[rel] = v) } : null;
      },
    };
    expect(swapInstallLinks('pink')).toBe(false);
    expect(links.manifest).toBe('/manifest.webmanifest');
    expect(swapInstallLinks('white')).toBe(true);
    expect(links.manifest).toBe('/themes/white/manifest.json');
    expect(links['apple-touch-icon']).toBe('/themes/white/icon-180.png');
    g.document = prev;
  });
});

describe('/white edition entry', () => {
  test('counts as ?theme=white once and lands on /', () => {
    store.clear();
    replaced.length = 0;
    href = 'https://web.bwalletx.com/white';
    expect(applyThemeParam()).toBe('white');
    expect(replaced).toEqual(['/']);
    store.set('bwx.accent.boot', 'cyber');
    href = 'https://web.bwalletx.com/white/';
    expect(applyThemeParam()).toBeNull();
    expect(store.get('bwx.accent.boot')).toBe('cyber');
  });
});
