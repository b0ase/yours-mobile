/**
 * On-device smoke test for the Android debug build: drives the app's WebView
 * over DevTools through create → force-stop (real process death) → relaunch →
 * unlock → receive. Proves the keystore persists natively across restarts.
 *
 *   pnpm cap:sync && (cd android && ./gradlew assembleDebug)
 *   adb install -r android/app/build/outputs/apk/debug/app-debug.apk
 *   pnpm exec tsx scripts/android-smoke.ts [outDir]
 *
 * Uses a throwaway wallet with a random password and clears app data first.
 */
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const APP = 'org.yours.wallet';
const ADB = process.env.ADB ?? join(homedir(), 'Library/Android/sdk/platform-tools/adb');
const OUT = process.argv[2] ?? 'smoke-screens/android';
const PORT = 9333;
const password = randomBytes(12).toString('base64url');
mkdirSync(OUT, { recursive: true });

const adb = (...args: string[]) => execFileSync(ADB, args, { encoding: 'buffer' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const launch = async (): Promise<{ browser: Browser; page: Page }> => {
  adb('shell', 'am', 'start', '-n', `${APP}/.MainActivity`);
  let pid = '';
  for (let i = 0; i < 40 && !pid; i++) {
    await sleep(500);
    pid = adb('shell', 'pidof', APP).toString().trim();
  }
  if (!pid) throw new Error('app did not start');
  await sleep(1500);
  adb('forward', '--remove-all');
  adb('forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
  let page: Page | undefined;
  for (let i = 0; i < 20 && !page; i++) {
    page = (await browser.pages()).find((p) => p.url().startsWith('https://localhost/'));
    if (!page) await sleep(500);
  }
  if (!page) throw new Error('app WebView page not found');
  return { browser, page };
};

const shot = async (name: string) => {
  await sleep(900);
  writeFileSync(join(OUT, `${name}.png`), adb('exec-out', 'screencap', '-p'));
  console.log(`  ✓ ${name}`);
};
const waitText = (page: Page, text: string, timeout = 120_000) =>
  page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
const clickText = (page: Page, text: string) => page.locator(`::-p-text(${text})`).setTimeout(60_000).click();

adb('shell', 'pm', 'clear', APP);
let session = await launch();
try {
  let { page } = session;
  console.log('create wallet');
  await waitText(page, 'Create New Wallet');
  await shot('01-start');
  await clickText(page, 'Create New Wallet');
  await page.locator('input[placeholder="Password"]').fill(password);
  await page.locator('input[placeholder="Confirm password"]').fill(password);
  await clickText(page, 'Generate Seed');
  await waitText(page, 'Your recovery phrase');
  await clickText(page, 'Next');
  await waitText(page, 'Wallet Ready!');
  await clickText(page, 'Enter');
  await waitText(page, 'Receive');
  await shot('02-wallet');

  console.log('force-stop and relaunch (process death)');
  session.browser.disconnect();
  adb('shell', 'am', 'force-stop', APP);
  session = await launch();
  page = session.page;
  await page.locator('input[type="password"]').setTimeout(60_000).wait();
  await shot('03-locked');
  await page.locator('input[type="password"]').fill(password);
  await page.keyboard.press('Enter');
  await waitText(page, 'Receive');
  await clickText(page, 'Receive');
  await shot('04-receive');
  console.log('\nandroid smoke passed');
} catch (error) {
  await shot('failure').catch(() => {});
  console.error(`android smoke FAILED: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  session.browser.disconnect();
  adb('forward', '--remove-all');
}
