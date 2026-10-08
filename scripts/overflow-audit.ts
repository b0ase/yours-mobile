/**
 * Horizontal overflow audit ("wobble"): drives the built mobile bundle in headless Chrome,
 * visits every tab, top-bar screen, Settings / Tools / About row (and the New Lock builder),
 * and at 320, 375 and 390 px wide reports any page or vertical scroller that is wider than
 * the screen, with the element(s) sticking out. A vertical scroller that is wider than its
 * box can be panned sideways on a phone, which is the wobble.
 *
 *   pnpm build:mobile && pnpm preview:mobile &
 *   bun scripts/overflow-audit.ts            # exit 1 when anything overflows
 *
 * Uses a throwaway wallet with a random password; nothing is funded or kept.
 * Rows that sign out, delete or reset are skipped.
 */
import puppeteer, { type Page } from 'puppeteer';
import { randomBytes } from 'crypto';

// EXT=build audits the Chrome extension build (side panel size) instead of the phone preview.
const EXT = process.env.EXT;
let URL = process.env.SMOKE_URL ?? 'http://localhost:4780/';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WIDTHS = EXT ? [360, 400] : [320, 375, 390];
/** Past the last content a page may keep its normal bottom padding (the tab bar / dock, ~5rem + safe area). */
const OVERSCROLL_MAX = 180;
const HEIGHT = Number(process.env.AUDIT_HEIGHT ?? 760);
const SKIP =
  /^v\d|lock wallet|sign out|log ?out|delete|remove|lock now|disable|reset|wipe|erase|forget|switch account|source code/i;
const password = randomBytes(12).toString('base64url');
const found = new Map<string, Set<string>>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitText = (page: Page, text: string, timeout = 60_000) =>
  page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);

/** In the page: every overflowing page/scroller and the outermost elements sticking out of it. */
const probe = (OVERSCROLL_MAX: number) => {
  const describe = (el: Element) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 6).join('.') : '';
    const text = (el as HTMLElement).innerText?.replace(/\s+/g, ' ').trim().slice(0, 40) ?? '';
    return `<${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}>${text ? ` "${text}"` : ''}`;
  };
  const out: string[] = [];
  const vw = document.documentElement.clientWidth;
  const scrollers: Element[] = [document.scrollingElement!];
  for (const el of document.querySelectorAll('*')) {
    const s = getComputedStyle(el);
    // Vertical scrollers (overflow-y auto/scroll): their x overflow is pannable. Intentional
    // sideways rows (overflow-x auto with overflow-y hidden/visible→auto pairs) are skipped.
    // Sideways scrollers on purpose (chip rows: overflow-x-auto) scroll inside themselves; skip them.
    if (
      /(auto|scroll)/.test(s.overflowX) &&
      /(auto|scroll)/.test(s.overflowY) &&
      !/overflow-x-(auto|scroll)/.test(el.getAttribute('class') ?? '')
    )
      scrollers.push(el);
  }
  for (const sc of scrollers) {
    const over = sc.scrollWidth - sc.clientWidth;
    if (over <= 2) continue;
    const box = sc === document.scrollingElement ? { left: 0, right: vw } : sc.getBoundingClientRect();
    const right = Math.min(box.right, vw);
    const sticking: Element[] = [];
    for (const el of sc.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || (r.right <= right + 1 && r.left >= box.left - 1)) continue;
      // Skip anything inside its own sideways scroller or a clipped box (it cannot move the page).
      let p = el.parentElement;
      let contained = false;
      while (p && p !== sc) {
        const ps = getComputedStyle(p);
        if (ps.overflowX !== 'visible' && p.getBoundingClientRect().right <= right + 1) contained = true;
        if (ps.position === 'fixed') contained = true;
        p = p.parentElement;
      }
      if (contained || getComputedStyle(el).position === 'fixed') continue;
      if (sticking.some((s) => s.contains(el))) continue;
      sticking.push(el);
    }
    // Nothing actually sticks out (e.g. a hidden tab keeping a stale width): not a wobble.
    if (!sticking.length) continue;
    out.push(
      `${sc === document.scrollingElement ? 'page' : describe(sc)} is ${over}px too wide: ` +
        (sticking.slice(0, 3).map(describe).join(' | ') ||
          `(nothing in flow; widest: ${[...sc.querySelectorAll('*')]
            .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)
            .slice(0, 2)
            .map(
              (e) =>
                `${describe(e)} right=${Math.round(e.getBoundingClientRect().right)} ${getComputedStyle(e).position}`,
            )
            .join(' | ')})`),
    );
  }
  // Vertical over-scroll: empty space after the last content (scrollHeight minus the last content's bottom).
  const vscrollers: Element[] = [document.scrollingElement!];
  for (const el of document.querySelectorAll('*')) {
    const st = getComputedStyle(el);
    if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 2 && el.getClientRects().length)
      vscrollers.push(el);
  }
  for (const sc of vscrollers) {
    const doc = sc === document.scrollingElement;
    const top = doc ? -window.scrollY : sc.getBoundingClientRect().top - sc.scrollTop;
    let bottom = 0;
    for (const el of sc.querySelectorAll('*')) {
      const st = getComputedStyle(el);
      if (st.position === 'fixed' || st.visibility === 'hidden' || !el.getClientRects().length) continue;
      if (
        el.children.length &&
        !(el as HTMLElement).innerText?.trim() &&
        !['IMG', 'VIDEO', 'CANVAS', 'svg'].includes(el.tagName)
      )
        continue;
      if (el.children.length) continue; // leaves only: wrappers carry the padding
      let nested = false; // content of an inner scroller is that scroller's, not this one's
      for (let q = el.parentElement; q && q !== sc; q = q.parentElement)
        if (/(auto|scroll)/.test(getComputedStyle(q).overflowY)) nested = true;
      if (nested) continue;
      const r = el.getBoundingClientRect();
      if (r.height === 0) continue;
      bottom = Math.max(bottom, r.bottom - top);
    }
    if (doc && sc.scrollHeight <= sc.clientHeight + 2) continue;
    const gap = sc.scrollHeight - bottom;
    if ((window as unknown as { __dump?: boolean }).__dump) {
      out.push(
        `DUMP ${describe(sc).slice(0, 80)} sh=${sc.scrollHeight} ch=${sc.clientHeight} bottom=${Math.round(bottom)}`,
      );
    }
    if (bottom > 0 && gap > OVERSCROLL_MAX)
      out.push(`${doc ? 'page' : describe(sc)} scrolls ${Math.round(gap)}px past its last content`);
  }
  return out;
};

const measure = async (page: Page, screen: string) => {
  // Measure the layout itself, not the mobile.css safeguard that hides it.
  await page.evaluate((d) => {
    document.documentElement.setAttribute('data-overflow-audit', '');
    (window as unknown as { __dump?: boolean }).__dump = d;
  }, !!process.env.DUMP);
  for (const w of WIDTHS) {
    await page.setViewport({ width: w, height: HEIGHT, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await sleep(500);
    for (const line of await page.evaluate(probe, OVERSCROLL_MAX)) {
      const key = `${screen} — ${line}`;
      if (!found.has(key)) found.set(key, new Set());
      found.get(key)!.add(String(w));
    }
  }
  await page.setViewport({
    width: WIDTHS[WIDTHS.length - 1],
    height: HEIGHT,
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });
};

const clickByText = async (page: Page, text: string) => {
  const ok = await page.evaluate((t) => {
    const els = [
      ...document.querySelectorAll('button, a, [role="button"], label, [class*="cursor-pointer"]'),
    ] as HTMLElement[];
    const el =
      els.find((e) => e.innerText?.trim().split('\n')[0].trim() === t) ??
      els.find((e) => e.innerText?.trim().startsWith(t));
    el?.click();
    return !!el;
  }, text);
  if (!ok) throw new Error(`no button "${text}"`);
  await sleep(1200);
};
const clickAria = async (page: Page, label: string) => {
  const ok = await page.evaluate((l) => {
    const el = ([...document.querySelectorAll(`[aria-label="${l}"]`)] as HTMLElement[]).find(
      (e) => e.getClientRects().length > 0,
    );
    el?.click();
    return !!el;
  }, label);
  if (!ok) throw new Error(`no visible [aria-label="${label}"]`);
  await sleep(1200);
};
const openSettings = async (page: Page) => {
  if (
    await page.evaluate(() =>
      [...document.querySelectorAll('[aria-label="Settings"]')].some((e) => e.getClientRects().length > 0),
    )
  )
    return clickAria(page, 'Settings');
  await clickAria(page, 'Accounts menu');
  await clickByText(page, 'Settings');
};
const acceptTerms = async (page: Page) => {
  await page.evaluate(() => {
    const b = ([...document.querySelectorAll('button')] as HTMLElement[]).find((e) =>
      /^(I agree|Agree|Accept)/i.test(e.innerText.trim()),
    );
    b?.click();
  });
  await sleep(1000);
};
const home = async (page: Page) => {
  // A row may have navigated away (a bApp, an external page): start again from the app.
  await page.goto(URL);
  await waitText(page, 'Wallet', 120_000);
  await sleep(800);
  await clickByText(page, 'Wallet');
  await waitText(page, 'Receive', 60_000);
};
/** Texts of the content rows on the current Settings section (not the tab bar / top bar / pills). */
const rows = (page: Page) =>
  page.evaluate(() =>
    ([...document.querySelectorAll('button, [role="button"], [class*="cursor-pointer"]')] as HTMLElement[])
      .filter((b) => b.getClientRects().length > 0 && !b.closest('nav'))
      .map((b) => b.innerText.trim().split('\n')[0].trim())
      .filter(
        (t) =>
          t.length > 1 && !['Wallet', 'Exchange', 'Market', 'Feed', 'Chat', 'Settings', 'Tools', 'About'].includes(t),
      ),
  );

const browser = EXT
  ? await puppeteer.launch({ headless: true, enableExtensions: [EXT], args: ['--no-first-run'] }) // Chrome for Testing
  : await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run'] });
if (EXT) {
  const sw = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
  );
  URL = `chrome-extension://${new globalThis.URL(sw.url()).hostname}/index.html`;
}
const page = await browser.newPage();
await page.emulate({
  viewport: { width: 390, height: HEIGHT, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
});
const errors: string[] = [];
const ONLY = process.env.STEPS ? new RegExp(process.env.STEPS, 'i') : null;
const step = async (name: string, go: () => Promise<void>) => {
  if (ONLY && !ONLY.test(name)) return;
  try {
    await home(page);
    await go();
    await measure(page, name);
    if (process.env.SHOTS) {
      await page.evaluate(() => {
        for (const el of [document.scrollingElement!, ...document.querySelectorAll('*')]) el.scrollTop = 1e6;
      });
      await sleep(400);
      await page.screenshot({ path: `${process.env.SHOTS}/${name.replace(/[^\w]+/g, '_')}.png` });
    }
    console.log(`  ✓ ${name}`);
  } catch (e) {
    errors.push(`${name}: ${e instanceof Error ? e.message : e}`);
    console.log(`  ✗ ${name}: ${e instanceof Error ? e.message.slice(0, 120) : e}`);
  }
};

try {
  await page.goto(URL);
  await waitText(page, 'Create New Wallet');
  await measure(page, 'start');
  await clickByText(page, 'Create New Wallet');
  await page.locator('input[placeholder="Password"]').fill(password);
  await page.locator('input[placeholder="Confirm password"]').fill(password);
  await page.evaluate(() =>
    document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((c) => !c.checked && c.click()),
  );
  await measure(page, 'create wallet');
  await clickByText(page, 'Generate Seed');
  await waitText(page, 'Your recovery phrase', 120_000);
  await measure(page, 'recovery phrase');
  await clickByText(page, 'Next');
  await waitText(page, 'Wallet Ready!', 120_000);
  await clickByText(page, 'Enter');
  await waitText(page, 'Wallet', 120_000);
  await measure(page, 'landing');

  await step('wallet', async () => {});
  await step('wallet › History', () => clickByText(page, 'History'));
  await step('wallet › Buy BSV', () => clickByText(page, 'Buy BSV'));
  await step('wallet › Receive', () => clickByText(page, 'Receive'));
  await step('wallet › Send', () => clickByText(page, 'Send'));
  for (const tab of ['Exchange', 'Feed', 'Chat'])
    await step(`tab ${tab}`, async () => {
      await clickByText(page, tab);
      await acceptTerms(page);
    });
  for (const aria of ['Calls', 'bX agent', 'Media', 'Lock BSV', 'Accounts menu'])
    await step(`top ${aria}`, async () => {
      await clickAria(page, aria);
    });

  for (const section of ['Settings', 'Tools', 'About']) {
    const open = async () => {
      await openSettings(page);
      if (section !== 'Settings') await clickByText(page, section);
    };
    let list: string[] = [];
    await step(section, async () => {
      await open();
      list = [...new Set(await rows(page))].filter((t) => !SKIP.test(t));
    });
    for (const r of list) await step(`${section} › ${r}`, async () => (await open(), await clickByText(page, r)));
  }
  // Time locks (top bar Lock BSV, /m/lock; on feat/time-locks builds only).
  await step('Lock BSV › New lock', async () => {
    await clickAria(page, 'Lock BSV');
    await clickByText(page, 'New lock');
  });
  await step('Lock BSV › New lock (preview filled in)', async () => {
    await clickAria(page, 'Lock BSV');
    await clickByText(page, 'New lock');
    const inputs = await page.$$('input[placeholder^="e.g."]');
    for (const [i, el] of inputs.entries()) await el.type(i === 0 ? '10' : '30');
    await sleep(1500);
  });
} catch (e) {
  const text = await page.evaluate(() => document.body.innerText).catch(() => '');
  errors.push(`setup: ${e instanceof Error ? e.message : e}; screen: ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
} finally {
  await browser.close();
}

if (errors.length) console.log(`\n${errors.length} screen(s) not reached:\n  ${errors.join('\n  ')}`);
if (found.size) {
  console.log(`\n${found.size} overflow(s):`);
  for (const [k, w] of found) console.log(`  [${[...w].join(',')}] ${k}`);
  process.exitCode = 1;
} else console.log('\nno horizontal or vertical overflow');
