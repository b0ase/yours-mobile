/**
 * Mobile smoke test: drives the built mobile bundle in a phone-sized headless
 * Chrome through create (lands unlocked) → reload (locks) → unlock → receive.
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
    // A failed request's console line has no URL or names it only for CORS; those are judged below from the
    // request and response lists, which carry the URL and status.
    if (msg.type() === 'error' && !/^Failed to load resource|blocked by CORS policy/.test(msg.text()))
      problems.push(`[${source}] ${msg.text()}`);
  };
  page.on('console', watch('page'));
  page.on('pageerror', (err) => problems.push(`[page] uncaught: ${err instanceof Error ? err.message : err}`));
  // Keep the URL and reason for failed requests: the console error alone doesn't say which.
  const failedRequests: string[] = [];
  page.on('requestfailed', (req) => failedRequests.push(`${req.failure()?.errorText} ${req.url().slice(0, 160)}`));
  (globalThis as { __failedRequests?: string[] }).__failedRequests = failedRequests;
  // And for "Failed to load resource: the server responded with a status of 404": which URL answered what.
  page.on('response', (res) => {
    if (res.status() >= 400)
      failedRequests.push(`${res.status()} ${res.request().method()} ${res.url().slice(0, 160)}`);
  });
  page.on('workercreated', (worker) => worker.on('console', watch('worker')));

  console.log('create wallet');
  await page.goto(URL);
  await waitText(page, 'Create New Wallet');
  await shot(page, '01-start');
  await clickText(page, 'Create New Wallet');
  // The two password boxes (placeholders as worded on the Create screen today).
  await page.locator('input[placeholder="Master password"]').fill(password);
  await page.locator('input[placeholder^="Master password again"]').fill(password);
  // "I've saved this password" (required since the onboarding redesign).
  const saved = await page.$('input[type="checkbox"]');
  if (saved) await saved.click();
  await clickText(page, 'Generate Seed');
  await waitText(page, 'Your recovery phrase', 120_000);
  await clickText(page, 'Next');
  await waitText(page, 'Wallet Ready!', 120_000);
  await shot(page, '02-ready');
  await clickText(page, 'Enter');
  await waitText(page, 'Receive', 120_000);
  await shot(page, '03-wallet');

  // The preview is not a native phone, so it runs as the web edition: the unlock key is held in memory only
  // (src/mobile/hub.ts persistSession, since 25 Oct 2026) and any page reload locks, as it does on web.bwalletx.com.
  // On a phone the session is mirrored to the WebView's sessionStorage and only goes when the app process dies.
  console.log('reload (web edition: session is memory only → locked)');
  await page.reload();
  await page.locator('input[type="password"]').setTimeout(60_000).wait();
  await shot(page, '04-locked');
  await page.locator('input[type="password"]').fill(password);
  await page.keyboard.press('Enter');
  await waitText(page, 'Receive', 120_000);
  await shot(page, '05-unlocked');

  console.log('receive');
  await clickText(page, 'Receive');
  // Web edition: a wallet with no backup is asked to back up before it can receive (the keys live only in this
  // browser), so a new wallet's Receive opens the backup step, not the address.
  await waitText(page, 'You need one before you can receive money', 30_000);
  await shot(page, '06-receive-backup-first');
  await clickText(page, 'Remind me later');
  await waitText(page, 'Receive', 30_000);

  console.log('apps page');
  // The Browser tab became Apps, opened from the top bar in the phone layout (src/mobile/tabs/TopNav.tsx).
  await page.locator('[aria-label="Apps"]').setTimeout(30_000).click();
  await page.locator('input[placeholder="Search or enter address"]').setTimeout(30_000).wait();
  await shot(page, '06b-apps');

  console.log('overlay window (chrome.tabs.create → sweep tool)');
  await page.evaluate(() => chrome.tabs.create({ url: chrome.runtime.getURL('sweep-tab.html') }));
  await page.waitForSelector('.yours-overlay iframe', { timeout: 30_000 });
  const frame = await page.waitForFrame((f) => f.url().includes('sweep-tab.html'), { timeout: 30_000 });
  // The tool opens under the one-time beta notice ("Tap anywhere to continue"): tap it away, as a person would.
  await frame.waitForFunction(() => /Tap anywhere to continue|Sweep/.test(document.body.innerText), {
    timeout: 60_000,
  });
  if (await frame.evaluate(() => document.body.innerText.includes('Tap anywhere to continue')))
    await frame.locator('::-p-text(Tap anywhere to continue)').click();
  await frame.waitForFunction(() => document.body.innerText.includes('Sweep'), { timeout: 60_000 });
  // The overlay page has its own chrome and reaches the background worker.
  const reply = await frame.evaluate(() => chrome.runtime.sendMessage({ action: 'getVersion' }));
  // The version string was "yours-wallet …" before the rebrand; it is "bwallet-mobile-<version>; …" now.
  if (!/"success":true/.test(JSON.stringify(reply)) || !/"version":"bwallet-/.test(JSON.stringify(reply)))
    throw new Error(`overlay bus reply: ${JSON.stringify(reply)}`);
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

// Failed requests a throwaway wallet in this preview is bound to make; anything else is a problem.
const EXPECTED: [RegExp, string][] = [
  // bMarketX allows the real wallet origins (web.bwalletx.com, the phone apps), not http://localhost:<port>.
  [
    /^net::ERR_FAILED https:\/\/bmarketx\.com\/api\/ebay\/wallet\/status/,
    'eBay link status: preview origin not on its CORS list',
  ],
  // "No $name for this key" is answered as 404.
  [/^404 GET https:\/\/pay\.bwallet\.space\/api\/paymail\/lookup\?key=/, 'a new wallet has no $name yet'],
  // WhatsOnChain answers 404 for an address that has never been used.
  [
    /^404 GET https:\/\/api\.whatsonchain\.com\/v1\/bsv\/main\/address\/[^/]+\/(un)?confirmed\/history/,
    'a new address has no history',
  ],
  // The page dropped its own request (a navigation or an unmounted screen).
  [/^net::ERR_ABORTED /, 'cancelled by the page'],
];
const failed = ((globalThis as { __failedRequests?: string[] }).__failedRequests ?? []).filter(
  (f) => !EXPECTED.some(([re]) => re.test(f)),
);
problems.push(...failed.map((f) => `[request] ${f}`));
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log('  ' + p.replaceAll(password, '<password>').slice(0, 400));
  process.exitCode = 1;
} else {
  console.log('\nsmoke passed');
}
