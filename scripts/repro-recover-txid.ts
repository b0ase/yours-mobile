/**
 * Real-browser check of Settings › Troubleshooting › Recover a payment by transaction ID on the web build
 * (owner, 15 Oct 2026: "Starting… (87 s)" forever). Throwaway wallet, random password, nothing funded.
 *
 *   pnpm build:web && pnpm preview:web &
 *   SHOTS=/tmp/shots bun scripts/repro-recover-txid.ts <txid> [<txid>...]
 */
import puppeteer, { type Page } from 'puppeteer';
import { randomBytes } from 'crypto';

const URL = process.env.SMOKE_URL ?? 'http://localhost:4781/';
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = process.env.SHOTS ?? '.';
const txids = process.argv.slice(2);
const password = randomBytes(12).toString('base64url');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitText = (page: Page, text: string, timeout = 60_000) =>
  page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
const clickByText = async (page: Page, text: string) => {
  const ok = await page.evaluate((t) => {
    const els = [
      ...document.querySelectorAll('button, a, [role="button"], label, [class*="cursor-pointer"]'),
    ] as HTMLElement[];
    const el =
      els.find((e) => e.getClientRects().length && e.innerText?.trim().split('\n')[0].trim() === t) ??
      els.find((e) => e.getClientRects().length && e.innerText?.trim().startsWith(t));
    el?.click();
    return !!el;
  }, text);
  if (!ok) throw new Error(`no button "${text}"`);
  await sleep(1200);
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const t0 = Date.now();
page.on('console', (m) => {
  const t = m.text();
  if (/recover|RECOVER|chrome shim|ensureWallet|Received message/i.test(t))
    console.log(`  [console +${((Date.now() - t0) / 1000).toFixed(1)}s] ${t.slice(0, 300)}`);
});
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
try {
  await page.goto(URL);
  await waitText(page, 'Create New Wallet', 120_000);
  await clickByText(page, 'Create New Wallet');
  await page.screenshot({ path: `${SHOTS}/create.png` });
  console.log(
    '  create inputs:',
    await page.evaluate(() =>
      [...document.querySelectorAll('input')].map((i) => `${i.placeholder}:${i.type}`).join(' | '),
    ),
  );
  await page.locator('input[placeholder="Master password"]').fill(password);
  await page.locator('input[placeholder="Master password again"]').fill(password);
  await page.evaluate(() =>
    document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((c) => !c.checked && c.click()),
  );
  await clickByText(page, 'Generate Seed');
  await waitText(page, 'Your recovery phrase', 120_000);
  await clickByText(page, 'Next');
  await waitText(page, 'Wallet Ready!', 120_000);
  await clickByText(page, 'Enter');
  await sleep(8000);
  if (await page.evaluate(() => document.body.innerText.includes('Remind me later')))
    await clickByText(page, 'Remind me later');
  await sleep(2000);
  const aria = async (l: string) =>
    page.evaluate((l) => {
      const el = ([...document.querySelectorAll(`[aria-label="${l}"]`)] as HTMLElement[]).find(
        (e) => e.getClientRects().length,
      );
      el?.click();
      return !!el;
    }, l);
  if (!(await aria('Settings'))) {
    await aria('Accounts menu');
    await sleep(1000);
    await clickByText(page, 'Settings');
  }
  await sleep(2000);
  await clickByText(page, 'Troubleshooting');
  await sleep(2000);
  if (!(await page.evaluate(() => document.body.innerText.includes('Recover a payment by transaction ID')))) {
    await page.screenshot({ path: `${SHOTS}/nav.png` });
    throw new Error('Troubleshooting page not reached; see nav.png');
  }
  await page.screenshot({ path: `${SHOTS}/troubleshooting.png` });
  console.log(
    '  inputs:',
    await page.evaluate(() =>
      [...document.querySelectorAll('input')].map((i) => `${i.id}:${i.getClientRects().length}`).join(' '),
    ),
  );
  // KNOWN=<txid>: seed a settled action for that txid straight into this throwaway wallet's IndexedDB (the record
  // localRecord reads), standing in for a payment already in the wallet. Nothing is funded or broadcast.
  if (process.env.KNOWN) {
    const seeded = await page.evaluate(async (txid) => {
      const names = (await indexedDB.databases())
        .map((d) => d.name ?? '')
        .filter((n) => n.startsWith('wallet-toolbox'));
      const out: string[] = [];
      for (const name of names) {
        const db: IDBDatabase = await new Promise((ok, no) => {
          const r = indexedDB.open(name);
          r.onsuccess = () => ok(r.result);
          r.onerror = () => no(r.error);
        });
        if (!db.objectStoreNames.contains('transactions') || !db.objectStoreNames.contains('users')) continue;
        const all = <T>(store: string): Promise<T[]> =>
          new Promise((ok) => {
            const r = db.transaction(store).objectStore(store).getAll();
            r.onsuccess = () => ok(r.result as T[]);
          });
        const users = await all<{ userId: number }>('users');
        for (const u of users) {
          const now = new Date();
          await new Promise((ok, no) => {
            const tx = db.transaction('transactions', 'readwrite');
            tx.objectStore('transactions').add({
              created_at: now,
              updated_at: now,
              userId: u.userId,
              status: 'completed',
              reference: 'reprotest' + Math.random().toString(36).slice(2, 8),
              isOutgoing: false,
              satoshis: 1234,
              description: 'repro: known payment',
              version: 1,
              lockTime: 0,
              txid,
            });
            tx.oncomplete = ok;
            tx.onerror = () => no(tx.error);
          });
          out.push(`${name} user ${u.userId}`);
        }
      }
      return out;
    }, process.env.KNOWN);
    console.log('  seeded known txid into:', seeded.join(', '));
  }
  // Record every RECOVER_PROGRESS the page receives (proves the background → page channel).
  await page.evaluate(() => {
    const w = window as unknown as { __progress: string[]; chrome: typeof chrome };
    w.__progress = [];
    w.chrome.runtime.onMessage.addListener((m: { action?: string; data?: { step?: string } }) => {
      if (m?.action === 'RECOVER_PROGRESS') w.__progress.push(m.data?.step ?? '');
    });
  });
  for (const [i, txid] of txids.entries()) {
    await page.locator('#recover-txid').fill(txid);
    const start = Date.now();
    await clickByText(page, 'Recover');
    let last = '';
    for (;;) {
      const text = await page.evaluate(() => {
        const el = document.querySelector('#recover-txid')?.closest('div.flex.flex-col');
        return (el as HTMLElement | null)?.innerText ?? '';
      });
      const line = text.split('\n')[1] ?? '';
      if (line !== last) console.log(`  [ui +${((Date.now() - start) / 1000).toFixed(1)}s] ${line}`);
      last = line;
      if (!/Checking|Starting|…\s*\(\d+ s\)/.test(line) || Date.now() - start > 120_000) break;
      await sleep(500);
    }
    if (await page.evaluate(() => document.body.innerText.includes('Skip for now')))
      await clickByText(page, 'Skip for now');
    await page.evaluate(() => document.querySelector('#recover-txid')?.scrollIntoView({ block: 'center' }));
    await sleep(500);
    await page.screenshot({ path: `${SHOTS}/recover-${i}.png` });
    console.log(
      '  progress seen by the page:',
      await page.evaluate(() => (window as unknown as { __progress: string[] }).__progress.splice(0).join(' → ')),
    );
    console.log(`  result for ${txid.slice(0, 8)} after ${((Date.now() - start) / 1000).toFixed(1)} s: ${last}`);
  }
} finally {
  await browser.close();
}
