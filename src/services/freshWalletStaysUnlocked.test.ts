import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { NEVER_LOCK, isSessionExpired } from '../utils/lockTimeout';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

/**
 * Fresh-install E2E, 30 Oct 2026: seconds after Create the wallet showed "Welcome back / Unlock". Create never wrote
 * lastActiveTime, and isSessionExpired treats a missing lastActiveTime as expired even with auto-lock Never, so the
 * inactivity alarm (and the worker's startup) locked it.
 */
describe('a freshly created or restored wallet stays unlocked with auto-lock Never', () => {
  test('root cause: no lastActiveTime counts as expired, a recent one never expires under Never', () => {
    expect(isSessionExpired(undefined, NEVER_LOCK)).toBe(true);
    expect(isSessionExpired(Date.now(), NEVER_LOCK)).toBe(false);
    expect(isSessionExpired(Date.now() - 365 * 86_400_000, NEVER_LOCK)).toBe(false);
  });

  test('storing new keys (Create and Restore) marks the wallet unlocked and active', () => {
    const keys = read('./Keys.service.ts');
    const store = keys.slice(keys.indexOf('private storeEncryptedKeys'), keys.indexOf('setPassKey(passKey)'));
    expect(store).toContain('isLocked: false');
    expect(store).toContain('lastActiveTime: Date.now()');
  });

  test('the account switch that ends Create / Restore marks it active before resuming waiting sites', () => {
    const bg = read('../background.ts');
    const sw = bg.slice(bg.indexOf('const switchAccount = async () => {'), bg.indexOf('reinitPromise = doSwitch();'));
    const mark = sw.indexOf('update({ isLocked: false, lastActiveTime: Date.now() })');
    expect(mark).toBeGreaterThan(0);
    expect(mark).toBeLessThan(sw.indexOf('resolveWalletWaiters()'));
  });

  test('a worker restart does not close the setup window (the person may be writing down their words)', () => {
    const bg = read('../background.ts');
    expect(bg).toContain("const setupUrl = chrome.runtime.getURL('index.html?setupFor=')");
    expect(bg).toContain('if (w.tabs?.some((t) => t.url?.startsWith(setupUrl))) continue;');
    expect(bg).toContain('chrome.runtime.getURL(`index.html?setupFor=');
  });

  test('waitForAuthentication waits on the wallet with the site deadlines, never an endless unlock wait', () => {
    const bg = read('../background.ts');
    const h = bg.slice(bg.indexOf('const processCWIWaitForAuthentication'), bg.indexOf('const processCWIListOutputs'));
    expect(h).toContain('await walletForSiteRequest(message.originator)');
    expect(h).not.toContain('await ensureWallet()');
  });
});
