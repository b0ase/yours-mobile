import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLOSE_FOR_RELOAD_ACTION,
  claimAccountSwitch,
  closeWalletForReload,
  releaseAccountSwitch,
  settleWithin,
} from './closeForReload';

const never = () => new Promise<void>(() => undefined);

describe('settleWithin', () => {
  it('reports done, failed and timeout, and never throws', async () => {
    expect(await settleWithin(() => Promise.resolve(1), 50)).toBe('done');
    expect(await settleWithin(() => undefined, 50)).toBe('done');
    expect(await settleWithin(() => Promise.reject(new Error('x')), 50)).toBe('failed');
    expect(
      await settleWithin(() => {
        throw new Error('sync');
      }, 50),
    ).toBe('failed');
    const t0 = Date.now();
    expect(await settleWithin(never, 30)).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('waits for a slow close that finishes inside the cap', async () => {
    let closed = false;
    const how = await settleWithin(() => new Promise<void>((r) => setTimeout(() => ((closed = true), r()), 20)), 500);
    expect(how).toBe('done');
    expect(closed).toBe(true);
  });
});

describe('closeWalletForReload', () => {
  it('awaits both closes before resolving', async () => {
    const order: string[] = [];
    await closeWalletForReload({
      legacyClose: () => new Promise<void>((r) => setTimeout(() => (order.push('legacy'), r()), 10)),
      closeBackground: () => new Promise<void>((r) => setTimeout(() => (order.push('background'), r()), 20)),
      capMs: 500,
    });
    order.push('reload');
    expect(order).toEqual(['legacy', 'background', 'reload']);
  });

  it('a hung close never holds the switch past the cap', async () => {
    const t0 = Date.now();
    const out = await closeWalletForReload({ legacyClose: never, closeBackground: never, capMs: 40 });
    expect(out).toEqual({ legacy: 'timeout', background: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('skips what is not there (the extension sends no background close)', async () => {
    expect(await closeWalletForReload({ capMs: 10 })).toEqual({ legacy: 'skipped', background: 'skipped' });
    expect(await closeWalletForReload({ closeBackground: () => Promise.reject(new Error('no')), capMs: 10 })).toEqual({
      legacy: 'skipped',
      background: 'failed',
    });
  });
});

describe('one switch at a time', () => {
  it('a second claim is refused until released', () => {
    releaseAccountSwitch();
    expect(claimAccountSwitch()).toBe(true);
    expect(claimAccountSwitch()).toBe(false);
    releaseAccountSwitch();
    expect(claimAccountSwitch()).toBe(true);
    releaseAccountSwitch();
  });
});

describe('wiring', () => {
  const src = (p: string) => readFileSync(join(import.meta.dir, p), 'utf8');

  it('both switchers close (awaited) before reloading, and never reload directly', () => {
    const hook = src('accountSwitch.ts');
    expect(hook).toContain('await closeAndReload(wallet)');
    expect(hook).not.toMatch(/^\s*wallet\?\.close\?\.\(\);/m);
    const topNav = src('../../components/TopNav.tsx');
    expect(topNav).toContain('await closeAndReload(wallet)');
    expect(topNav).not.toContain('window.location.reload()');
    expect(topNav).not.toMatch(/^\s*wallet\?\.close\?\.\(\);/m);
  });

  it('the background answers the close, keeps the wallet closed, and refuses it in the extension', () => {
    const bg = src('../../background.ts');
    expect(CLOSE_FOR_RELOAD_ACTION).toBe('WALLET_CLOSE_FOR_RELOAD');
    expect(bg).toContain('case CLOSE_FOR_RELOAD_ACTION:');
    // Internal pages only: listed with the other popup-only actions.
    const list = bg.slice(bg.indexOf('const noAuthRequired = ['), bg.indexOf('if (noAuthRequired.includes'));
    expect(list).toContain('CLOSE_FOR_RELOAD_ACTION');
    const handler = bg.slice(bg.indexOf('case CLOSE_FOR_RELOAD_ACTION:'), bg.indexOf("case 'WALLET_UNLOCKED':"));
    expect(handler.indexOf('if (IS_EXTENSION)')).toBeLessThan(handler.indexOf('closedForReload = true'));
    expect(bg).toMatch(/if \(closedForReload\) \{[\s\S]{0,200}return null;/);
  });
});
