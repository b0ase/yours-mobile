import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { BANNER_VIDEO, bannerHtml, installWebBanner } from './betaBanner';

const css = readFileSync(new URL('./web.css', import.meta.url), 'utf8');

describe('web beta banner', () => {
  test('two actions and a close; video only when the file exists', () => {
    const html = bannerHtml(false);
    expect(html).toContain('data-bw-banner="swap">Swap into BSV');
    expect(html).toContain('data-bw-banner="buy">Buy BSV');
    expect(html).toContain('data-bw-banner="close"');
    expect(html).not.toContain('<video');
    expect(bannerHtml(true)).toContain(`src="/${BANNER_VIDEO}" autoplay loop muted playsinline`);
    expect(BANNER_VIDEO).toBe('media/beta-hazard.mp4');
  });

  test('hazard tape in CSS, scrolling, still for reduced motion, and it takes layout height', () => {
    expect(css).toContain('repeating-linear-gradient(-45deg, #f5b800');
    expect(css).toContain('animation: bw-hazard-scroll');
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.bwallet-web-banner\s*\{\s*animation: none/);
    expect(css).toMatch(/\.bwallet-web-banner \{\s*position: relative;/);
  });

  test('dismissed for the session: hidden on the next load, height released', () => {
    const store = new Map<string, string>();
    const props = new Map<string, string>();
    let removed = false;
    let click: ((e: unknown) => void) | null = null;
    const events: string[] = [];
    const el = {
      remove: () => (removed = true),
      addEventListener: (_: string, f: (e: unknown) => void) => (click = f),
    };
    const g = globalThis as Record<string, unknown>;
    const saved = ['document', 'sessionStorage', 'window', 'CustomEvent'].map((k) => [k, g[k]] as const);
    g.document = {
      documentElement: { style: { setProperty: (k: string, v: string) => props.set(k, v) } },
      querySelector: () => (removed ? null : el),
    };
    g.sessionStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    };
    g.CustomEvent = class {
      constructor(
        public type: string,
        public init: { detail: string },
      ) {}
    };
    g.window = { dispatchEvent: (e: { init: { detail: string } }) => events.push(e.init.detail) };
    try {
      installWebBanner();
      const target = (action: string) => ({ target: { closest: () => ({ getAttribute: () => action }) } });
      click!(target('buy'));
      click!(target('swap'));
      expect(events).toEqual(['buy', 'swap']);
      expect(removed).toBe(false);
      click!(target('close'));
      expect(removed).toBe(true);
      expect(props.get('--web-banner-height')).toBe('0px');
      // Next load in the same session: hidden straight away.
      removed = false;
      props.clear();
      installWebBanner();
      expect(removed).toBe(true);
      expect(props.get('--web-banner-height')).toBe('0px');
      // A new session (new tab / next visit): shown again.
      store.clear();
      removed = false;
      installWebBanner();
      expect(removed).toBe(false);
    } finally {
      for (const [k, v] of saved) g[k] = v;
    }
  });
});
