/**
 * Mobile smoke test: drives the built mobile bundle in a phone-sized headless
 * Chrome through create → restart (locks) → unlock → receive.
 *
 *   pnpm build:mobile && pnpm exec vite preview -c vite.config.mobile.ts --port 4780 &
 *   pnpm test:mobile-smoke [outDir]
 *
 * Uses a throwaway wallet with a random password; nothing is funded or kept.
 */
import puppeteer, { type Page } from 'puppeteer';
import { randomBytes } from 'crypto';
import { mkdirSync } from 'fs';
import { join } from 'path';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4780/';
const OUT = process.argv[2] ?? 'smoke-screens';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const password = randomBytes(12).toString('base64url');
const problems: string[] = [];

mkdirSync(OUT, { recursive: true });

const shot = async (page: Page, name: string) => {
  await new Promise((r) => setTimeout(r, 900)); // let entrance animations settle
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`  ✓ ${name}`);
};

const clickText = (page: Page, text: string) => page.locator(`::-p-text(${text})`).setTimeout(60_000).click();
const waitText = (page: Page, text: string, timeout = 60_000) =>
  page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-first-run'],
});

const page = await browser.newPage();
try {
  await page.emulate({
    viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  });
  const watch = (source: string) => (msg: { type: () => string; text: () => string }) => {
    if (msg.type() === 'error') problems.push(`[${source}] ${msg.text()}`);
  };
  page.on('console', watch('page'));
  page.on('pageerror', (err) => problems.push(`[page] uncaught: ${err instanceof Error ? err.message : err}`));
  page.on('workercreated', (worker) => worker.on('console', watch('worker')));

  console.log('create wallet');
  await page.goto(URL);
  await waitText(page, 'Create New Wallet');
  await shot(page, '01-start');
  await clickText(page, 'Create New Wallet');
  await page.locator('input[placeholder="Password"]').fill(password);
  await page.locator('input[placeholder="Confirm password"]').fill(password);
  await clickText(page, 'Generate Seed');
  await waitText(page, 'Your recovery phrase', 120_000);
  await clickText(page, 'Next');
  await waitText(page, 'Wallet Ready!', 120_000);
  await shot(page, '02-ready');
  await clickText(page, 'Enter');
  await waitText(page, 'Receive', 120_000);
  await shot(page, '03-wallet');

  console.log('reload (session kept → stays unlocked)');
  await page.reload();
  await waitText(page, 'Receive', 120_000);

  console.log('restart app (session cleared → locked)');
  // Process death: sessionStorage (chrome.storage.session) goes, native prefs stay.
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.locator('input[type="password"]').setTimeout(60_000).wait();
  await shot(page, '04-locked');
  await page.locator('input[type="password"]').fill(password);
  await page.keyboard.press('Enter');
  await waitText(page, 'Receive', 120_000);
  await shot(page, '05-unlocked');

  console.log('receive');
  await clickText(page, 'Receive');
  await new Promise((r) => setTimeout(r, 1500));
  await shot(page, '06-receive');

  console.log('overlay window (chrome.tabs.create → sweep tool)');
  await page.evaluate(() => chrome.tabs.create({ url: chrome.runtime.getURL('sweep-tab.html') }));
  await page.waitForSelector('.yours-overlay iframe', { timeout: 30_000 });
  const frame = await page
    .waitForFrame((f) => f.url().includes('sweep-tab.html'), { timeout: 30_000 })
    .then(
      async (f) => (await f.waitForFunction(() => document.body.innerText.includes('Sweep'), { timeout: 60_000 }), f),
    );
  // The overlay page has its own chrome and reaches the background worker.
  const reply = await frame.evaluate(() => chrome.runtime.sendMessage({ action: 'getVersion' }));
  if (!JSON.stringify(reply).includes('yours-wallet')) throw new Error(`overlay bus reply: ${JSON.stringify(reply)}`);
  await shot(page, '07-overlay');
  const windows = await page.evaluate(() => chrome.windows.getAll({ populate: true }));
  if (windows.length !== 1) throw new Error(`expected 1 overlay window, got ${windows.length}`);
  await page.click('.yours-overlay-close');
  await page.waitForFunction(() => !document.querySelector('.yours-overlay'), { timeout: 10_000 });
  console.log('  ✓ overlay closed');
} catch (error) {
  problems.push(`[smoke] ${error instanceof Error ? error.message : error}`);
  await page.screenshot({ path: join(OUT, 'failure.png') }).catch(() => {});
  const text = await page.evaluate(() => document.body.innerText).catch(() => '');
  problems.push(`[smoke] screen text: ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
} finally {
  await browser.close();
}

if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log('  ' + p.replaceAll(password, '<password>').slice(0, 400));
  process.exitCode = 1;
} else {
  console.log('\nsmoke passed');
}
