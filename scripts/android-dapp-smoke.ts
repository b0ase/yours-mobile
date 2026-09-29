/**
 * On-device dApp browser test (Android debug build, wallet already created and
 * unlocked, e.g. right after scripts/android-smoke.ts). Opens a test dApp in
 * the in-app browser, calls window.CWI, approves the permission prompt.
 *
 *   python3 -m http.server 4790   # serving a page that exposes #ver #auth #pk buttons and #log
 *   pnpm exec tsx scripts/android-dapp-smoke.ts http://10.0.2.2:4790/ [outDir]
 */
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const APP = 'com.bitcoincorp.yourswalletmobile';
const ADB = process.env.ADB ?? join(homedir(), 'Library/Android/sdk/platform-tools/adb');
const DAPP = process.argv[2] ?? 'http://10.0.2.2:4790/';
const OUT = process.argv[3] ?? 'smoke-screens/android-dapp';
const PORT = 9334;
mkdirSync(OUT, { recursive: true });
const adb = (...a: string[]) => execFileSync(ADB, a, { encoding: 'buffer' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shot = (name: string) => {
  writeFileSync(join(OUT, `${name}.png`), adb('exec-out', 'screencap', '-p'));
  console.log(`  ✓ ${name}`);
};
const pageFor = async (browser: Browser, match: (url: string) => boolean, timeout = 30_000): Promise<Page> => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const found = (await browser.pages()).find((p) => match(p.url()));
    if (found) return found;
    await sleep(500);
  }
  throw new Error('page not found');
};
const logText = (p: Page) => p.evaluate(() => document.getElementById('log')!.textContent ?? '');
const waitLog = (p: Page, text: string) =>
  p.waitForFunction((t) => document.getElementById('log')!.textContent!.includes(t), { timeout: 90_000 }, text);

const pid = adb('shell', 'pidof', APP).toString().trim();
if (!pid) throw new Error('app not running');
adb('forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
let failed = false;
try {
  const wallet = await pageFor(browser, (u) => u.startsWith('https://localhost/'));
  console.log('open dApp via window.open');
  await wallet.evaluate((url) => void window.open(url, '_blank'), DAPP);
  const dapp = await pageFor(browser, (u) => u.startsWith(DAPP));
  await dapp.waitForFunction(() => document.readyState === 'complete');
  const cwi = await dapp.evaluate(() => typeof (window as unknown as { CWI?: unknown }).CWI);
  if (cwi !== 'object') throw new Error(`window.CWI is ${cwi}`);
  await sleep(800);
  shot('01-dapp');

  await dapp.click('#ver');
  await waitLog(dapp, 'getVersion');
  await dapp.click('#auth');
  await waitLog(dapp, 'isAuthenticated');
  console.log('  ' + (await logText(dapp)).trim().replace(/\n/g, '\n  '));

  console.log('getPublicKey → permission prompt');
  await dapp.click('#pk');
  // The prompt renders in an overlay iframe of the wallet page (the browser steps aside).
  const frame = await wallet.waitForFrame((f) => f.url().includes('prompt.html'), { timeout: 60_000 });
  await frame.waitForFunction(() => document.body.innerText.includes('Allow'), { timeout: 60_000 });
  await sleep(800);
  shot('02-prompt');
  await frame.locator('::-p-text(Allow)').setTimeout(60_000).click();
  await waitLog(dapp, 'getPublicKey');
  await sleep(800);
  shot('03-after-allow');
  const final = await logText(dapp);
  console.log('  ' + final.trim().split('\n').pop());
  if (!/getPublicKey: \{"publicKey":"0[23][0-9a-f]{64}"\}/.test(final))
    throw new Error('getPublicKey did not return a key');
  console.log('\ndapp smoke passed');
} catch (error) {
  failed = true;
  shot('failure');
  console.error(`dapp smoke FAILED: ${error instanceof Error ? error.message : error}`);
} finally {
  browser.disconnect();
  adb('forward', '--remove', `tcp:${PORT}`);
  process.exitCode = failed ? 1 : 0;
}
