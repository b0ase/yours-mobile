/**
 * Onboarding smoke test: Restore (12 words) and Import (private keys) in the built mobile bundle, each in a clean
 * browser profile. Both must land on the wallet home UNLOCKED after "Enter" (src/pages/onboarding/enterWallet.ts):
 * the preview runs as the web edition, whose unlock key is held in memory only, so a page reload there would show
 * "Welcome back / Unlock".
 *
 *   node_modules/.bin/vite preview -c vite.config.mobile.ts --port 4780 &
 *   SMOKE_URL=http://localhost:4780/ node_modules/.bin/tsx scripts/mobile-onboarding-smoke.ts [restore|import]
 *
 * The words and keys are made here at random for each run; nothing is funded or kept.
 */
import puppeteer, { type Page } from 'puppeteer';
import { randomBytes } from 'crypto';
import { generateMnemonic } from 'bip39';
import { PrivateKey } from '@bsv/sdk';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4780/';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ONLY = process.argv[2];
const password = randomBytes(12).toString('base64url');
const problems: string[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clickText = (page: Page, text: string) => page.locator(`::-p-text(${text})`).setTimeout(30_000).click();
const waitText = (page: Page, text: string, timeout = 60_000) =>
  page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);

/**
 * Restore and Import each open under the one-tap beta notice (src/mobile/sweep/BetaGate.tsx; the whole notice is the
 * button). Tap it away if it is up, then wait for the screen behind it.
 */
const passBetaGate = async (page: Page, then: string) => {
  await page.waitForFunction(
    (t) => !!document.querySelector('[data-testid="beta-gate"]') || document.body.innerText.includes(t),
    { timeout: 30_000 },
    then,
  );
  await page.evaluate(() => document.querySelector<HTMLElement>('[data-testid="beta-gate"]')?.click());
};

/** Start → Restore Wallet → (the one-time beta notice) → the "Restore a Wallet" list. */
const openRestoreList = async (page: Page) => {
  await page.goto(URL);
  await waitText(page, 'Restore Wallet');
  await clickText(page, 'Restore Wallet');
  await passBetaGate(page, 'Restore a Wallet');
  await waitText(page, 'Restore a Wallet', 30_000);
};

/** Password, confirm, Finish, the finish screen, Enter: then the wallet home with no lock screen. */
const finishAndEnter = async (page: Page, done: string) => {
  // The account name is required on this screen (a suggestion is not always filled in).
  const name = page.locator('input[placeholder="e.g. Savings"]');
  await name.fill('Smoke');
  for (const el of await page.$$('input[type="password"]')) await el.type(password);
  await page.evaluate(() =>
    document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((c) => !c.checked && c.click()),
  );
  await clickText(page, 'Finish');
  await page.waitForFunction(
    (t) => document.body.innerText.includes(t) && !document.body.innerText.includes('Finish'),
    { timeout: 240_000 },
    done,
  );
  await clickText(page, 'Enter');
  await waitText(page, 'Receive', 120_000);
  await sleep(6000); // the lock check runs every 5 s (ServiceProvider.tsx): it must still be open after one
  const text = await page.evaluate(() => document.body.innerText);
  if (/Welcome back|Enter your password to unlock/.test(text) || (await page.$('input[type="password"]')))
    throw new Error('lock screen after Enter');
  if (!text.includes('Receive')) throw new Error('wallet home not shown after Enter');
};

const flows: Record<string, (page: Page) => Promise<void>> = {
  restore: async (page) => {
    await openRestoreList(page);
    await clickText(page, 'Yours Wallet');
    await page.locator('textarea[placeholder="Enter secret recovery words"]').fill(generateMnemonic());
    await clickText(page, 'Next');
    await finishAndEnter(page, 'Wallet Restored!');
  },
  import: async (page) => {
    await openRestoreList(page);
    await clickText(page, 'Restore with private key');
    await passBetaGate(page, 'Next');
    const wif = () => PrivateKey.fromRandom().toWif();
    await page.locator('input[placeholder="Pay WIF private key"]').fill(wif());
    await page.locator('input[placeholder="Ord WIF private key"]').fill(wif());
    await page.locator('input[placeholder="Identity WIF private key"]').fill(wif());
    await clickText(page, 'Next');
    await finishAndEnter(page, 'Enter');
  },
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run'] });
for (const [name, run] of Object.entries(flows)) {
  if (ONLY && ONLY !== name) continue;
  // A clean profile each time: the flows start from "no wallet".
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.emulate({
    viewport: { width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  });
  try {
    await run(page);
    console.log(`  ✓ ${name}: unlocked on the wallet home after Enter`);
  } catch (error) {
    const text = await page.evaluate(() => document.body.innerText).catch(() => '');
    const inputs = await page
      .evaluate(() =>
        [...document.querySelectorAll('input,textarea')].map((i) => (i as HTMLInputElement).placeholder).join(' | '),
      )
      .catch(() => '');
    problems.push(
      `${name}: ${error instanceof Error ? error.message : error}; screen: ${text.replace(/\s+/g, ' ').slice(0, 300)}; inputs: ${inputs}`,
    );
  } finally {
    await context.close();
  }
}
await browser.close();

if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log('  ' + p.replaceAll(password, '<password>').slice(0, 700));
  process.exitCode = 1;
} else {
  console.log('\nonboarding smoke passed');
}
