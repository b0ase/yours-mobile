/**
 * Renders the main wallet view (siteLookRender.fixture.tsx) in headless Chrome with the app's real stylesheets
 * (Tailwind, mobile.css, accent.css, themes.css) and measures what is painted: each element's computed ink against
 * the pixels behind it (a screenshot with the glyphs hidden), so a dark-on-dark card or white-on-paper title fails
 * however the CSS got there. Used by siteLookRender.test.ts and the before/after screenshots.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'puppeteer';
import { contrast, rgbToHex } from '../mobile/theme/colour';

const CHROMES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];
/** A Chrome already on the machine (nothing is downloaded), or null. */
export const chromePath = (): string | null => CHROMES.find((p): p is string => !!p && existsSync(p)) ?? null;

/** Headless Chrome that may load the fixture's ES modules from file:// (null when no Chrome is installed). */
export async function launchChrome(): Promise<Browser | null> {
  const executablePath = chromePath();
  if (!executablePath) return null;
  const { default: puppeteer } = await import('puppeteer');
  return puppeteer.launch({
    headless: true,
    executablePath,
    args: ['--no-first-run', '--allow-file-access-from-files', '--no-sandbox'],
  });
}

/** Bundles the fixture and compiles the app CSS into a temp folder; returns the folder. */
/** `store`: the store edition (bWallet: the yellow card, Apps in the dock), as VITE_STORE_BUILD=1 builds it. */
export async function buildFixture(opts: { store?: boolean } = {}): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'bw-sitelook-'));
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, '..', 'mobile', 'theme', 'siteLookRender.fixture.tsx')],
    outdir: dir,
    target: 'browser',
    format: 'esm',
    splitting: true,
    loader: { '.svg': 'file', '.png': 'file', '.jpg': 'file', '.webp': 'file', '.woff2': 'file', '.woff': 'file' },
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.env': JSON.stringify({
        MODE: 'production',
        DEV: false,
        PROD: true,
        ...(opts.store ? { VITE_STORE_BUILD: '1' } : {}),
      }),
    },
  });
  if (!built.success) throw new Error(built.logs.map(String).join('\n'));
  const js = built.outputs.filter((o) => o.path.endsWith('.js'));
  const cssOut = built.outputs.filter((o) => o.path.endsWith('.css')).map((o) => readFileSync(o.path, 'utf8'));
  // Every token in the bundle is a Tailwind candidate; Tailwind ignores the ones that are not classes.
  const candidates = new Set<string>();
  for (const o of js)
    for (const t of readFileSync(o.path, 'utf8').split(/[\s"'`\\]+/)) if (t.length < 80) candidates.add(t);
  const { compile } = await import('@tailwindcss/node');
  const src = join(import.meta.dir, '..');
  // The app's order: mobile.css (main.ts) before index.css (Tailwind, accent.css, themes.css).
  const compiler = await compile(`@import './mobile/mobile.css';\n@import './index.css';\n`, {
    base: src,
    onDependency: () => undefined,
  });
  writeFileSync(join(dir, 'app.css'), [...cssOut, compiler.build([...candidates])].join('\n'));
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
      '<link rel="stylesheet" href="./app.css"></head><body><div id="root"></div>' +
      '<script type="module" src="./siteLookRender.fixture.js"></script></body></html>',
  );
  return dir;
}

export type Fixture = {
  theme: Record<string, unknown> | null;
  identityPubKey: string;
  storage?: Record<string, string>;
  /** A bundled pack id painted instead of a site theme. */
  pack?: string;
};

/** A card picture (the card designer's own photo) as a data: URL: a warm photo-like gradient, bright at the top. */
export function cardPictureUri(): string {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><defs><linearGradient id="g" x1="0" y1="0" ' +
    'x2="0" y2="1"><stop offset="0" stop-color="rgb(246,220,138)"/><stop offset="1" stop-color="rgb(46,40,38)"/>' +
    '</linearGradient></defs><rect width="640" height="400" fill="url(#g)"/></svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/** Opens the fixture at the side panel's size with the given theme; resolves once it has painted. */
export async function openView(browser: Browser, dir: string, fx: Fixture): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 860, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument((f: Fixture) => {
    (window as unknown as { __SITE_THEME: Fixture }).__SITE_THEME = f;
    try {
      for (const [k, v] of Object.entries(f.storage ?? {})) localStorage.setItem(k, v);
    } catch {
      /* file:// storage blocked: the fixture still renders */
    }
  }, fx);
  await page.goto('file://' + join(dir, 'index.html'));
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __READY?: boolean; __ERROR?: string };
      return w.__READY || w.__ERROR;
    },
    { timeout: 60_000 },
  );
  const err = await page.evaluate(() => (window as unknown as { __ERROR?: string }).__ERROR);
  if (err) throw new Error(err);
  await page.evaluate(() => document.fonts.ready);
  return page;
}

export type Target = { name: string; kind: 'text' | 'icon'; select: string; text?: string; all?: boolean };
export type Reading = { name: string; kind: 'text' | 'icon'; fg: string; bg: string; ratio: number };

type Box = { name: string; kind: 'text' | 'icon'; fg: [number, number, number, number]; rect: number[] };

/** The painted ink and ground of every target (one reading per matched element). */
export async function measure(page: Page, targets: Target[]): Promise<Reading[]> {
  const boxes: Box[] = await page.evaluate((ts: Target[]) => {
    // Any computed colour (rgb(), color(srgb …) from color-mix) as sRGB bytes, read back through a canvas.
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    const rgba = (s: string): [number, number, number, number] => {
      if (!ctx) return [0, 0, 0, 1];
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = s;
      ctx.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 255] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const out: Box[] = [];
    for (const t of ts) {
      // Painted elements only (the lazy carousel keeps a hidden copy of the card while it loads).
      let els = [...document.querySelectorAll(t.select)].filter(
        (e) =>
          e.getClientRects().length > 0 &&
          e.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
          !e.parentElement?.closest('[aria-hidden="true"]'),
      );
      if (t.text) els = els.filter((e) => (e.textContent ?? '').trim() === t.text);
      if (!t.all) els = els.slice(0, 1);
      if (!els.length) out.push({ name: t.name + ' (missing)', kind: t.kind, fg: [0, 0, 0, 0], rect: [0, 0, 0, 0] });
      for (const el of els) {
        let rect: DOMRect;
        if (t.kind === 'text') {
          const r = document.createRange();
          r.selectNodeContents(el);
          rect = r.getBoundingClientRect();
        } else rect = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const fg = t.kind === 'icon' ? (cs.stroke && cs.stroke !== 'none' ? cs.stroke : cs.color) : cs.color;
        out.push({ name: t.name, kind: t.kind, fg: rgba(fg), rect: [rect.left, rect.top, rect.width, rect.height] });
      }
    }
    return out;
  }, targets);
  // The ground: the same page with every glyph and icon stroke hidden.
  const hide = await page.addStyleTag({
    content:
      '*{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important}' +
      'svg,svg *{stroke:transparent!important}',
  });
  const shot = Buffer.from(await page.screenshot({ type: 'png' })).toString('base64');
  await hide.evaluate((n) => n.remove());
  // Average the ground under each box, decoding the screenshot through a canvas in the page.
  const grounds: ([number, number, number] | null)[] = await page.evaluate(
    async (png: string, rects: number[][]) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + png;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return rects.map(() => null);
      ctx.drawImage(img, 0, 0);
      return rects.map(([x = 0, y = 0, w = 0, h = 0]) => {
        const x0 = Math.max(0, Math.round(x));
        const y0 = Math.max(0, Math.round(y));
        const w0 = Math.min(c.width - x0, Math.round(w));
        const h0 = Math.min(c.height - y0, Math.round(h));
        if (w0 <= 0 || h0 <= 0) return null;
        const d = ctx.getImageData(x0, y0, w0, h0).data;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let i = 0; i < d.length; i += 4) {
          r += d[i] as number;
          g += d[i + 1] as number;
          b += d[i + 2] as number;
        }
        const n = d.length / 4;
        return [r / n, g / n, b / n];
      });
    },
    shot,
    boxes.map((b) => b.rect),
  );
  return boxes.map((b, i) => {
    const bg = grounds[i];
    if (!bg) return { name: b.name, kind: b.kind, fg: '#000000', bg: '#000000', ratio: 0 };
    const a = b.fg[3];
    const ink = [0, 1, 2].map((k) => (b.fg[k] as number) * a + (bg[k] as number) * (1 - a)) as [number, number, number];
    const fgHex = rgbToHex(...ink);
    const bgHex = rgbToHex(...bg);
    return { name: b.name, kind: b.kind, fg: fgHex, bg: bgHex, ratio: contrast(fgHex, bgHex) };
  });
}

/** The main view's elements from the COO report (7 Nov 2026), plus the rest of the top row, card and dock. */
export const MAIN_VIEW_TARGETS: Target[] = [
  { name: 'top row: price', kind: 'text', select: 'button[aria-label="BSV price"] > span:first-child' },
  { name: 'top row: % today', kind: 'text', select: '.bw-daychange' },
  { name: 'top row: Buy BSV', kind: 'text', select: '.bw-toprow button', text: 'Buy BSV' },
  { name: 'top row: History', kind: 'text', select: '.bw-toprow button', text: 'History' },
  { name: 'Swap into BSV: title', kind: 'text', select: '.bw-swaprow span', text: 'Swap into BSV' },
  { name: 'Swap into BSV: subtitle', kind: 'text', select: '.bw-swaprow span.text-\\[11px\\]' },
  { name: 'card: balance', kind: 'text', select: '.bw-wcard-front .bw-wcard-usd' },
  { name: 'card: sats', kind: 'text', select: '.bw-wcard-front .bw-wcard-sats' },
  { name: 'card: Scan pill', kind: 'text', select: '.bw-wcard-front .bw-wcard-scan > span' },
  { name: 'card: Get your $name', kind: 'text', select: '.bw-wcard-front .bw-wcard-getname' },
  { name: 'card: address line', kind: 'text', select: '.bw-wcard-front .bw-wcard-addr' },
  { name: 'card: $ / BSV switch (on)', kind: 'text', select: '.bw-wcard-front .bw-wcard-unit button.is-on' },
  { name: 'live pill (#D92D20, white text)', kind: 'text', select: '[data-fixture-live-pill]' },
  { name: 'dock: badge', kind: 'text', select: 'nav[data-phone-dock] .bw-unread-badge', all: true },
  { name: 'dock: icon', kind: 'icon', select: 'nav[data-phone-dock] button:not(.bw-dock-b) svg', all: true },
  {
    name: 'dock: label',
    kind: 'text',
    select: 'nav[data-phone-dock] button:not(.bw-dock-b) > span:last-child',
    all: true,
  },
];
